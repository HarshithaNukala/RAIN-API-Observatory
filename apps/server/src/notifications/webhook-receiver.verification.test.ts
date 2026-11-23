import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CreateMonitorSchema, UpdateNotificationSettingsSchema } from '@rain/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.js';
import type { CheckExecution } from '../monitoring/executor.js';
import { createMonitorService } from '../monitors/monitor-service.js';
import { createInMemoryMonitorRepository } from '../test-support/in-memory-monitor-repository.js';
import { createInMemoryMonitoringStore } from '../test-support/in-memory-monitoring-store.js';
import {
  createInMemoryDispatchStore,
  createInMemoryNotificationRepository,
} from '../test-support/in-memory-notification-store.js';
import { startLocalTarget, type LocalTarget } from '../test-support/local-target.js';
import { UNCONFIGURED_EMAIL_PROVIDER } from './email.js';
import { createNotificationDispatcher } from './notification-dispatcher.js';
import { createNotificationService } from './notification-service.js';
import { createWebhookSender } from './webhook-sender.js';

/**
 * Phase 8 webhook verification with a controlled receiver. The receiver verifies signatures with
 * the snippet published in docs/notifications.md (copied verbatim below, independent of RAIN's own
 * verifyWebhookSignature). Delivery goes through the real SSRF-safe transport (DNS validation and
 * IP pinning; the pinned socket is diverted to a local server), the real dispatcher and retry
 * policy, and the delivery history API. No network security is relaxed: the receiver is reached
 * only because the injected resolver answers with a public address.
 */

// --- Verbatim from docs/notifications.md ("Verifying signatures") ---------------------------------
function verify(secret: string, rawBody: string, signature: string, timestamp: string) {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isInteger(Number(timestamp)) || age > 300) return false;
  const expected =
    'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return (
    expected.length === signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
}
// -------------------------------------------------------------------------------------------------

const owner = randomUUID();
const secretBox = createSecretBox({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
let target: LocalTarget;

beforeEach(async () => {
  target = await startLocalTarget();
});
afterEach(async () => {
  await target.close();
});

describe('webhook delivery to a controlled receiver', () => {
  it('signs every attempt, retries a temporary failure, keeps the delivery ID, and records history', async () => {
    let clock = Date.now();
    const now = () => new Date(clock);
    const repo = createInMemoryMonitorRepository();
    const monitors = createMonitorService({
      repository: repo,
      profiles: {
        ensure: async (id) => ({
          id,
          displayName: null,
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
        }),
      },
      secretBox,
      maxMonitorsPerUser: 5,
      now,
    });
    const notifications = createNotificationService({
      repository: createInMemoryNotificationRepository(repo),
      secretBox,
      emailConfigured: false,
      now,
    });
    const checks = createInMemoryMonitoringStore(repo, { now });
    const dispatch = createInMemoryDispatchStore(repo, { now });

    const monitor = await monitors.create(
      owner,
      CreateMonitorSchema.parse({ name: 'Payments', url: 'https://api.example.com/health' }),
    );
    const { signingSecret } = await notifications.updateSettings(
      owner,
      null,
      monitor.id,
      UpdateNotificationSettingsSchema.parse({
        webhook: {
          enabled: true,
          url: 'http://receiver.example.com/hooks/rain',
          header: { name: 'Authorization', value: 'Bearer receiver-token' },
        },
      }),
    );

    // Two failed checks open an incident, which queues the webhook in the same transaction.
    const failure: CheckExecution = {
      checkedAt: now(),
      result: {
        outcome: 'FAILURE',
        statusCode: 503,
        latencyMs: 30,
        failureReason: 'UNEXPECTED_STATUS',
      },
      errorMessage: 'expected status 200, received 503',
      response: null,
    };
    for (let i = 0; i < 2; i++) {
      repo.monitors[0]!.nextCheckAt = new Date(clock - 1000);
      const [claim] = await checks.claim(5, 90);
      await checks.complete(claim!, { ...failure, checkedAt: now() });
    }
    expect(repo.notificationDeliveries).toHaveLength(1);

    const dispatcher = createNotificationDispatcher({
      store: dispatch,
      email: UNCONFIGURED_EMAIL_PROVIDER,
      webhook: createWebhookSender({
        transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
      }),
      secretBox,
      logger: pino({ level: 'silent' }),
      appBaseUrl: 'https://rain.example.com',
      now,
      random: () => 0,
    });

    // Attempt 1: the receiver is temporarily unavailable.
    target.reply('/hooks/rain', 'POST', 503);
    await dispatcher.pollOnce();
    const delivery = repo.notificationDeliveries[0]!;
    expect(delivery).toMatchObject({ status: 'PENDING', attempts: 1 });
    clock = delivery.nextAttemptAt.getTime(); // 15 s later (30 s nominal, jitter at minimum)

    // Attempt 2: accepted.
    target.reply('/hooks/rain', 'POST', 202);
    await dispatcher.pollOnce();
    expect(delivery).toMatchObject({ status: 'SENT', attempts: 2 });

    // What the receiver saw: two signed requests for the same delivery, both verifiable.
    expect(target.captured).toHaveLength(2);
    for (const req of target.captured) {
      expect(req.headers.authorization).toBe('Bearer receiver-token');
      expect(req.headers['x-rain-event']).toBe('INCIDENT_CREATED');
      expect(req.headers['x-rain-delivery']).toBe(delivery.id);
      expect(
        verify(
          signingSecret!,
          req.body!,
          req.headers['x-rain-signature']!,
          req.headers['x-rain-timestamp']!,
        ),
      ).toBe(true);
      // A tampered body or another secret fails verification.
      expect(
        verify(
          signingSecret!,
          req.body!.replace('Payments', 'Pay'),
          req.headers['x-rain-signature']!,
          req.headers['x-rain-timestamp']!,
        ),
      ).toBe(false);
      expect(
        verify(
          'whsec_wrong',
          req.body!,
          req.headers['x-rain-signature']!,
          req.headers['x-rain-timestamp']!,
        ),
      ).toBe(false);
      const body = JSON.parse(req.body!);
      expect(body).toMatchObject({
        deliveryId: delivery.id,
        eventType: 'INCIDENT_CREATED',
        monitor: { name: 'Payments' },
      });
      expect(JSON.stringify(body)).not.toMatch(/api\.example\.com|receiver-token|whsec_/);
    }
    // The same delivery ID on the retry lets the receiver de-duplicate.
    expect(new Set(target.captured.map((r) => r.body && JSON.parse(r.body).deliveryId)).size).toBe(
      1,
    );
    // DNS was resolved and validated for each attempt, through the SSRF-safe transport.
    expect(target.resolverCalls).toEqual(['receiver.example.com', 'receiver.example.com']);

    // Delivery history shows both attempts.
    const detail = await notifications.get(owner, delivery.id);
    expect(detail).toMatchObject({
      status: 'SENT',
      attempts: 2,
      destination: 'receiver.example.com',
      lastError: null,
    });
    expect(detail.attemptHistory.map((a) => [a.attemptNumber, a.outcome, a.httpStatus])).toEqual([
      [1, 'TEMPORARY_FAILURE', 503],
      [2, 'SUCCESS', 202],
    ]);
  });
});
