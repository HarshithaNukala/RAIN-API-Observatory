import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  WEBHOOK_HEADERS,
  WebhookHeaderSchema,
  findMonitorUrlIssue,
  type NotificationPayload,
  type WebhookBody,
} from '@rain/shared';
import { request, type Dispatcher } from 'undici';
import {
  drainResponseBody,
  noResponseReason,
  type MonitorTransport,
} from '../monitoring/executor.js';
import { isSafeDispatcher } from '../monitoring/safe-transport.js';
import {
  classifyHttpStatus,
  webhookDestination,
  type DeliveryResult,
} from './notification-rules.js';

/**
 * Webhook delivery. The destination is user-configured, so it gets exactly the monitor executor's
 * protections: the SSRF-safe transport (every A/AAAA answer validated, IP pinned, TLS verified,
 * revalidated per connection, no proxies), the registration URL rules (http/https, ports 80/443, no
 * private literals or local names, no credentials in the URL), no redirects and no retries inside
 * an attempt. Payloads are signed with HMAC-SHA256 over `<timestamp>.<body>`.
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RESPONSE_READ_LIMIT = 8 * 1024;
/** Receivers should reject signatures older than this (replay window). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** `v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>` */
export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `v1=${mac}`;
}

/**
 * Reference verification for receivers (and tests): constant-time comparison plus a timestamp
 * window. Replays inside the window are caught with the delivery ID, which receivers should store.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const ts = Number(input.timestamp);
  if (!input.signature || !Number.isInteger(ts)) return false;
  if (
    Math.abs(input.nowSeconds - ts) >
    (input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS)
  ) {
    return false;
  }
  const expected = Buffer.from(signWebhook(input.secret, ts, input.body));
  const given = Buffer.from(input.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface WebhookDelivery {
  deliveryId: string;
  url: string;
  secret: string;
  header: { name: string; value: string } | null;
  payload: NotificationPayload;
}

export interface WebhookSender {
  send(delivery: WebhookDelivery): Promise<DeliveryResult>;
}

const NO_RESPONSE_TEXT = {
  TIMEOUT: 'no response in time',
  DNS_ERROR: 'the host name could not be resolved',
  CONNECTION_ERROR: 'the connection failed or was closed',
  TLS_ERROR: 'TLS handshake or certificate verification failed',
  BLOCKED_DESTINATION: 'the destination is not allowed',
  REQUEST_ERROR: 'the request could not be completed',
  CONFIGURATION_ERROR: 'the request was not sent',
} as const;

export function createWebhookSender(deps: {
  transport: MonitorTransport;
  userAgent?: string;
  now?: () => Date;
  timeoutMs?: number;
}): WebhookSender {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const userAgent = deps.userAgent ?? 'RAIN-API-Observatory-Webhooks/0.1';

  function dispatcher(): Dispatcher | null {
    const t = deps.transport;
    return t.kind === 'dispatcher' && isSafeDispatcher(t.dispatcher) ? t.dispatcher : null;
  }

  return {
    async send(d) {
      // Only the host ever appears in errors and logs.
      const host = webhookDestination(d.url);
      const safe = dispatcher();
      if (!safe) {
        return {
          outcome: 'PERMANENT_FAILURE',
          httpStatus: null,
          error: 'Outbound webhooks are disabled: no SSRF-safe transport is configured',
        };
      }
      const urlIssue = findMonitorUrlIssue(d.url);
      if (urlIssue) {
        return {
          outcome: 'PERMANENT_FAILURE',
          httpStatus: null,
          error: `Webhook URL not allowed: ${urlIssue.message}`,
        };
      }
      if (d.header && !WebhookHeaderSchema.safeParse(d.header).success) {
        return {
          outcome: 'PERMANENT_FAILURE',
          httpStatus: null,
          error: 'Webhook header is not valid',
        };
      }

      const body: WebhookBody = { ...d.payload, deliveryId: d.deliveryId };
      const json = JSON.stringify(body);
      const ts = Math.floor(now().getTime() / 1000);
      const headers: Record<string, string> = {
        ...(d.header && { [d.header.name.toLowerCase()]: d.header.value }),
        'content-type': 'application/json',
        'user-agent': userAgent,
        [WEBHOOK_HEADERS.event]: d.payload.eventType,
        [WEBHOOK_HEADERS.delivery]: d.deliveryId,
        [WEBHOOK_HEADERS.timestamp]: String(ts),
        [WEBHOOK_HEADERS.signature]: signWebhook(d.secret, ts, json),
      };

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        // undici's request() never follows redirects unless an interceptor is added; none is.
        const response = await request(d.url, {
          dispatcher: safe,
          method: 'POST',
          headers,
          body: json,
          signal: controller.signal,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
        await drainResponseBody(response.body, WEBHOOK_RESPONSE_READ_LIMIT);
        const status = response.statusCode;
        if (status >= 300 && status < 400) {
          return {
            outcome: 'PERMANENT_FAILURE',
            httpStatus: status,
            error: `Webhook ${host} answered with a redirect (HTTP ${status}); redirects are not followed`,
          };
        }
        const outcome = classifyHttpStatus(status);
        return outcome === 'SUCCESS'
          ? { outcome, httpStatus: status }
          : { outcome, httpStatus: status, error: `Webhook ${host} answered HTTP ${status}` };
      } catch (err) {
        const reason = noResponseReason(err, timedOut);
        return {
          // The SSRF guard's refusal is permanent; network trouble may pass.
          outcome: reason === 'BLOCKED_DESTINATION' ? 'PERMANENT_FAILURE' : 'TEMPORARY_FAILURE',
          httpStatus: null,
          error: `Webhook ${host}: ${NO_RESPONSE_TEXT[reason]}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
