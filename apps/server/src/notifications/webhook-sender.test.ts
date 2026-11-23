import { randomUUID } from 'node:crypto';
import { WebhookBodySchema, type NotificationPayload } from '@rain/shared';
import { Agent, MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startLocalTarget, type LocalTarget } from '../test-support/local-target.js';
import {
  createWebhookSender,
  signWebhook,
  verifyWebhookSignature,
  type WebhookDelivery,
} from './webhook-sender.js';

// Real SSRF-safe transport (injected resolver and socket factory) against a local HTTP server:
// every request below goes through the same DNS validation, IP pinning and connection rules as
// production. Nothing leaves the machine.

const SECRET = 'whsec_test-signing-secret';
const NOW = new Date('2026-11-19T10:00:00.000Z');
let target: LocalTarget;

beforeEach(async () => {
  target = await startLocalTarget();
});
afterEach(async () => {
  await target.close();
});

const payload: NotificationPayload = {
  eventId: randomUUID(),
  eventType: 'INCIDENT_CREATED',
  occurredAt: NOW.toISOString(),
  incident: {
    id: randomUUID(),
    title: 'Payments is down',
    severity: 'HIGH',
    status: 'OPEN',
    summary: 'Detected automatically after 2 consecutive failed checks.',
    startedAt: NOW.toISOString(),
    resolvedAt: null,
  },
  monitor: { id: randomUUID(), name: 'Payments' },
};

const sender = (timeoutMs?: number) =>
  createWebhookSender({
    transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
    now: () => NOW,
    ...(timeoutMs && { timeoutMs }),
  });

const delivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  deliveryId: randomUUID(),
  url: 'http://hooks.example.com/rain',
  secret: SECRET,
  header: null,
  payload,
  ...overrides,
});

describe('webhook delivery', () => {
  it('POSTs the signed JSON body with event, delivery and timestamp headers', async () => {
    target.reply('/rain', 'POST', 204);
    const d = delivery({ header: { name: 'Authorization', value: 'Bearer receiver-token' } });
    const result = await sender().send(d);
    expect(result).toEqual({ outcome: 'SUCCESS', httpStatus: 204 });

    const [req] = target.captured;
    expect(req!.headers['content-type']).toBe('application/json');
    expect(req!.headers['x-rain-event']).toBe('INCIDENT_CREATED');
    expect(req!.headers['x-rain-delivery']).toBe(d.deliveryId);
    expect(req!.headers['x-rain-timestamp']).toBe(String(NOW.getTime() / 1000));
    expect(req!.headers.authorization).toBe('Bearer receiver-token');
    const body = WebhookBodySchema.parse(JSON.parse(req!.body!));
    expect(body).toEqual({ ...payload, deliveryId: d.deliveryId });
    // A receiver can verify it with the shared secret.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: req!.body!,
        signature: req!.headers['x-rain-signature'],
        timestamp: req!.headers['x-rain-timestamp'],
        nowSeconds: NOW.getTime() / 1000 + 10,
      }),
    ).toBe(true);
    // DNS validated and pinned like any monitor check.
    expect(target.resolverCalls).toEqual(['hooks.example.com']);
    expect(target.pinned).toHaveLength(1);
  });

  it('classifies responses: 5xx/429 temporary, other 4xx permanent', async () => {
    target.reply('/rain', 'POST', 503);
    target.reply('/rain', 'POST', 429);
    target.reply('/rain', 'POST', 404);
    expect(await sender().send(delivery())).toEqual({
      outcome: 'TEMPORARY_FAILURE',
      httpStatus: 503,
      error: 'Webhook hooks.example.com answered HTTP 503',
    });
    expect((await sender().send(delivery())).outcome).toBe('TEMPORARY_FAILURE');
    expect(await sender().send(delivery())).toMatchObject({
      outcome: 'PERMANENT_FAILURE',
      httpStatus: 404,
    });
  });

  it('never follows redirects', async () => {
    target.reply('/rain', 'POST', 302, '', { location: 'http://169.254.169.254/latest/meta-data' });
    const result = await sender().send(delivery());
    expect(result).toMatchObject({ outcome: 'PERMANENT_FAILURE', httpStatus: 302 });
    expect(result.outcome !== 'SUCCESS' && result.error).toMatch(/redirects are not followed/);
    expect(target.captured).toHaveLength(1);
    expect(target.resolverCalls).toEqual(['hooks.example.com']);
  });

  it('refuses a host that resolves to a private address, without connecting', async () => {
    target.setDnsAnswers([{ address: '10.0.0.7', family: 4 }]);
    const result = await sender().send(delivery());
    expect(result).toEqual({
      outcome: 'PERMANENT_FAILURE',
      httpStatus: null,
      error: 'Webhook hooks.example.com: the destination is not allowed',
    });
    expect(target.pinned).toHaveLength(0);
    expect(target.captured).toHaveLength(0);
  });

  it('refuses a mixed public/private DNS answer (rebinding-style)', async () => {
    target.setDnsAnswers([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    expect((await sender().send(delivery())).outcome).toBe('PERMANENT_FAILURE');
    expect(target.captured).toHaveLength(0);
  });

  it('re-validates DNS on every delivery: a host that rebinds to a private address is refused', async () => {
    target.reply('/rain', 'POST', 200);
    expect((await sender().send(delivery())).outcome).toBe('SUCCESS');
    target.setDnsAnswers([{ address: '169.254.169.254', family: 4 }]);
    expect((await sender().send(delivery())).outcome).toBe('PERMANENT_FAILURE');
    expect(target.captured).toHaveLength(1);
  });

  it.each([
    ['a private IP literal', 'http://10.0.0.1/hook'],
    ['localhost', 'http://localhost/hook'],
    ['a non-standard port', 'https://hooks.example.com:8443/hook'],
    ['credentials in the URL', 'https://user:pw@hooks.example.com/hook'],
    ['a non-HTTP scheme', 'ftp://hooks.example.com/hook'],
  ])('refuses %s before any network activity', async (_label, url) => {
    const result = await sender().send(delivery({ url }));
    expect(result).toMatchObject({ outcome: 'PERMANENT_FAILURE', httpStatus: null });
    expect(target.resolverCalls).toHaveLength(0);
  });

  it('times out as a temporary failure', async () => {
    target.reply('/rain', 'POST', 200, '', {}, { delayMs: 600 });
    expect(await sender(200).send(delivery())).toEqual({
      outcome: 'TEMPORARY_FAILURE',
      httpStatus: null,
      error: 'Webhook hooks.example.com: no response in time',
    });
  });

  it('connection failures are temporary', async () => {
    target.failNextConnection(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    expect((await sender().send(delivery())).outcome).toBe('TEMPORARY_FAILURE');
  });

  it('refuses headers that would override RAIN’s own', async () => {
    const result = await sender().send(
      delivery({ header: { name: 'X-Rain-Signature', value: 'forged' } }),
    );
    expect(result).toMatchObject({
      outcome: 'PERMANENT_FAILURE',
      error: 'Webhook header is not valid',
    });
    expect(target.captured).toHaveLength(0);
  });

  it('refuses any transport that is not the SSRF-safe one', async () => {
    for (const dispatcher of [new Agent(), new MockAgent()]) {
      const unsafe = createWebhookSender({ transport: { kind: 'dispatcher', dispatcher } });
      expect(await unsafe.send(delivery())).toMatchObject({
        outcome: 'PERMANENT_FAILURE',
        error: expect.stringMatching(/SSRF-safe transport/),
      });
      await dispatcher.close();
    }
  });
});

describe('signature verification', () => {
  const body = '{"a":1}';
  const ts = 1_795_000_000;
  const signature = signWebhook(SECRET, ts, body);

  it('accepts a fresh, matching signature', () => {
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body,
        signature,
        timestamp: String(ts),
        nowSeconds: ts,
      }),
    ).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets, missing headers and stale timestamps', () => {
    const base = { secret: SECRET, body, signature, timestamp: String(ts), nowSeconds: ts };
    expect(verifyWebhookSignature({ ...base, body: '{"a":2}' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, secret: 'whsec_other' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, signature: undefined })).toBe(false);
    expect(verifyWebhookSignature({ ...base, timestamp: 'nope' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, nowSeconds: ts + 301 })).toBe(false);
    // The timestamp is signed: changing it invalidates the signature.
    expect(verifyWebhookSignature({ ...base, timestamp: String(ts + 1), nowSeconds: ts + 1 })).toBe(
      false,
    );
  });
});
