import { NotificationPayloadSchema } from '@rain/shared';
import type { Logger } from 'pino';
import { DecryptionError, type SecretBox } from '../crypto/secret-box.js';
import { safeError } from '../monitoring/worker-engine.js';
import { webhookHeaderContext, webhookSecretContext } from '../monitors/secret-contexts.js';
import type { ClaimedDelivery, DispatchStore } from './dispatch-store.js';
import { renderIncidentEmail, type EmailProvider } from './email.js';
import { decideAfterAttempt, type DeliveryResult } from './notification-rules.js';
import type { WebhookSender } from './webhook-sender.js';

/**
 * Delivers queued notifications, independently of monitoring (its own loop, own concurrency).
 *
 *   poll → claim (SKIP LOCKED, leased, attempt counted) → load context → send (no transaction)
 *        → complete (short transaction, lease-token guarded)
 *
 * Delivery is at-least-once: if the worker dies after the provider accepted a message but before
 * the result was recorded, the lease expires and the delivery is retried. The delivery ID is sent
 * as the email provider's idempotency key and in the webhook body and headers, so receivers can
 * de-duplicate.
 */

export interface DispatcherSettings {
  concurrency: number;
  pollIntervalMs: number;
  /** Must exceed the longest send (15 s email, 10 s webhook) plus a margin. */
  leaseSeconds: number;
  maxBackoffMs: number;
}

export const DEFAULT_DISPATCHER_SETTINGS: DispatcherSettings = {
  concurrency: 10,
  pollIntervalMs: 2000,
  leaseSeconds: 60,
  maxBackoffMs: 30_000,
};
export const MIN_DISPATCH_LEASE_SECONDS = 30;

export interface NotificationDispatcherDependencies {
  store: DispatchStore;
  email: EmailProvider;
  webhook: WebhookSender;
  secretBox: SecretBox;
  logger: Logger;
  appBaseUrl: string;
  settings?: Partial<DispatcherSettings>;
  now?: () => Date;
  random?: () => number;
}

export interface NotificationDispatcher {
  start(): void;
  stop(graceMs: number): Promise<{ drained: boolean; abandoned: number }>;
  /** One poll without the loop; resolves when the claimed deliveries finish. */
  pollOnce(): Promise<number>;
  readonly inFlight: number;
}

const permanent = (error: string): DeliveryResult => ({
  outcome: 'PERMANENT_FAILURE',
  httpStatus: null,
  error,
});

export function createNotificationDispatcher(
  deps: NotificationDispatcherDependencies,
): NotificationDispatcher {
  const settings = { ...DEFAULT_DISPATCHER_SETTINGS, ...deps.settings };
  if (!Number.isInteger(settings.concurrency) || settings.concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  if (settings.leaseSeconds < MIN_DISPATCH_LEASE_SECONDS) {
    throw new RangeError(`leaseSeconds must be at least ${MIN_DISPATCH_LEASE_SECONDS}`);
  }
  const { store, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const active = new Set<Promise<void>>();
  let running = false;
  let stopping = false;
  let loopDone: Promise<void> = Promise.resolve();
  let wake: (() => void) | null = null;
  let consecutiveErrors = 0;

  async function attempt(claim: ClaimedDelivery): Promise<DeliveryResult> {
    const { delivery } = claim;
    const payload = NotificationPayloadSchema.safeParse(delivery.payload);
    if (!payload.success) return permanent('The stored notification payload is not valid');
    const context = await store.loadContext(delivery);

    if (delivery.channel === 'EMAIL') {
      if (!context.ownerEmail) return permanent('The account has no email address');
      const message = renderIncidentEmail(payload.data, deps.appBaseUrl);
      return deps.email.send({ ...message, to: context.ownerEmail, idempotencyKey: delivery.id });
    }

    const s = context.settings;
    if (!s || !s.webhookEnabled || !s.webhookUrl || !s.webhookSecretCiphertext) {
      return permanent('The webhook was removed or disabled after this notification was queued');
    }
    try {
      const secret = deps.secretBox.decrypt(
        {
          ciphertext: s.webhookSecretCiphertext,
          iv: s.webhookSecretIv!,
          authTag: s.webhookSecretAuthTag!,
          keyVersion: s.webhookSecretKeyVersion!,
        },
        webhookSecretContext(s.monitorId),
      );
      const header =
        s.webhookHeaderName && s.webhookHeaderCiphertext
          ? {
              name: s.webhookHeaderName,
              value: deps.secretBox.decrypt(
                {
                  ciphertext: s.webhookHeaderCiphertext,
                  iv: s.webhookHeaderIv!,
                  authTag: s.webhookHeaderAuthTag!,
                  keyVersion: s.webhookHeaderKeyVersion!,
                },
                webhookHeaderContext(s.monitorId, s.webhookHeaderName),
              ),
            }
          : null;
      return deps.webhook.send({
        deliveryId: delivery.id,
        url: s.webhookUrl,
        secret,
        header,
        payload: payload.data,
      });
    } catch (err) {
      if (err instanceof DecryptionError) {
        return permanent('The webhook secret could not be decrypted');
      }
      throw err;
    }
  }

  async function run(claim: ClaimedDelivery): Promise<void> {
    const { delivery } = claim;
    const log = logger.child({
      deliveryId: delivery.id,
      channel: delivery.channel,
      eventType: delivery.eventType,
      attempt: delivery.attempts,
    });
    const startedAt = now();
    let result: DeliveryResult;
    try {
      result = await attempt(claim);
    } catch (err) {
      // Unexpected (e.g. database while loading context): retry like a temporary failure.
      log.error({ error: safeError(err) }, 'notification attempt failed unexpectedly');
      result = {
        outcome: 'TEMPORARY_FAILURE',
        httpStatus: null,
        error: 'Internal error while sending',
      };
    }
    const finishedAt = now();
    const decision = decideAfterAttempt(
      result,
      delivery.attempts,
      delivery.maxAttempts,
      finishedAt,
      deps.random,
    );
    try {
      const recorded = await store.complete(claim, { startedAt, finishedAt, result, decision });
      log.info(
        {
          outcome: result.outcome,
          httpStatus: result.httpStatus,
          status: recorded ? decision.status : 'DISCARDED_STALE',
          nextAttemptAt:
            decision.status === 'PENDING' ? decision.nextAttemptAt.toISOString() : undefined,
        },
        'notification attempt recorded',
      );
    } catch (err) {
      // The lease will expire and the delivery is retried (at-least-once).
      log.warn({ error: safeError(err) }, 'could not record the attempt; the lease will expire');
    }
  }

  async function claimAndStart(): Promise<Array<Promise<void>>> {
    const free = settings.concurrency - active.size;
    if (free <= 0) return [];
    const claims = await store.claim(free, settings.leaseSeconds);
    return claims.map((claim) => {
      const task = run(claim).finally(() => {
        active.delete(task);
        wake?.();
      });
      active.add(task);
      return task;
    });
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      let delay = settings.pollIntervalMs;
      try {
        const requested = settings.concurrency - active.size;
        const started = await claimAndStart();
        consecutiveErrors = 0;
        if (requested > 0 && started.length === requested) delay = settings.pollIntervalMs / 10;
      } catch (err) {
        consecutiveErrors++;
        delay = Math.min(settings.maxBackoffMs, settings.pollIntervalMs * 2 ** consecutiveErrors);
        logger.warn({ error: safeError(err), retryInMs: delay }, 'claiming notifications failed');
      }
      if (!stopping) await pause(delay);
    }
  }

  return {
    get inFlight() {
      return active.size;
    },
    start() {
      if (running) return;
      running = true;
      logger.info(
        { ...settings, emailConfigured: deps.email.configured },
        'notification dispatcher polling',
      );
      loopDone = loop();
    },
    async stop(graceMs) {
      stopping = true;
      wake?.();
      await loopDone;
      if (active.size === 0) return { drained: true, abandoned: 0 };
      let timer: NodeJS.Timeout | undefined;
      const graceOver = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), graceMs);
      });
      const outcome = await Promise.race([Promise.allSettled([...active]), graceOver]);
      clearTimeout(timer);
      return outcome === 'timeout'
        ? { drained: false, abandoned: active.size }
        : { drained: true, abandoned: 0 };
    },
    async pollOnce() {
      const started = await claimAndStart();
      await Promise.allSettled(started);
      return started.length;
    },
  };
}
