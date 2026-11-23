import { randomUUID } from 'node:crypto';
import type { NotificationPayload } from '@rain/shared';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RESEND_ENDPOINT,
  UNCONFIGURED_EMAIL_PROVIDER,
  createResendProvider,
  renderIncidentEmail,
} from './email.js';

// The Resend adapter against undici's MockAgent: no email ever leaves the machine.

const payload: NotificationPayload = {
  eventId: randomUUID(),
  eventType: 'INCIDENT_CREATED',
  occurredAt: '2026-11-19T10:00:00.000Z',
  incident: {
    id: randomUUID(),
    title: 'Payments <script>alert(1)</script> is down',
    severity: 'CRITICAL',
    status: 'OPEN',
    summary: 'Detected automatically after 2 consecutive failed checks. Last check: timed out.',
    startedAt: '2026-11-19T10:00:00.000Z',
    resolvedAt: null,
  },
  monitor: { id: randomUUID(), name: 'Payments & Billing' },
};

describe('renderIncidentEmail', () => {
  it('includes monitor, title, severity, status, time, summary and the incident link; escapes HTML', () => {
    const { subject, html, text } = renderIncidentEmail(payload, 'https://rain.example.com/');
    expect(subject).toBe('[RAIN] Incident opened: Payments <script>alert(1)</script> is down');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Payments &lt;script&gt;alert(1)&lt;/script&gt; is down');
    expect(html).toContain('Payments &amp; Billing');
    expect(html).toContain('CRITICAL');
    expect(html).toContain('OPEN');
    expect(html).toContain('19 Nov 2026, 10:00 UTC');
    expect(html).toContain(`href="https://rain.example.com/app/incidents/${payload.incident.id}"`);
    expect(text).toContain(
      `View incident: https://rain.example.com/app/incidents/${payload.incident.id}`,
    );
    expect(text).toContain('Last check: timed out.');
  });

  it('words resolution emails accordingly', () => {
    const resolved = renderIncidentEmail(
      {
        ...payload,
        eventType: 'INCIDENT_RESOLVED',
        occurredAt: '2026-11-19T10:12:00.000Z',
        incident: {
          ...payload.incident,
          status: 'RESOLVED',
          resolvedAt: '2026-11-19T10:12:00.000Z',
        },
      },
      'https://rain.example.com',
    );
    expect(resolved.subject).toMatch(/^\[RAIN\] Resolved: /);
    expect(resolved.text).toContain('Resolved: 19 Nov 2026, 10:12 UTC');
    expect(resolved.text).toContain('Started: 19 Nov 2026, 10:00 UTC');
  });
});

describe('Resend provider', () => {
  let mock: MockAgent;
  afterEach(async () => {
    await mock.close();
  });

  function provider() {
    mock = new MockAgent();
    mock.disableNetConnect();
    return {
      api: mock.get(new URL(RESEND_ENDPOINT).origin),
      provider: createResendProvider({
        apiKey: 're_test_key_123',
        from: 'RAIN <alerts@example.com>',
        dispatcher: mock,
      }),
    };
  }
  const message = {
    to: 'owner@example.com',
    subject: 's',
    html: '<p>h</p>',
    text: 't',
    idempotencyKey: 'delivery-1',
  };

  it('sends with the API key, the idempotency key and the message', async () => {
    const { api, provider: p } = provider();
    let seen: { headers: Record<string, string>; body: unknown } | undefined;
    api.intercept({ path: '/emails', method: 'POST' }).reply(200, (opts) => {
      seen = {
        headers: opts.headers as Record<string, string>,
        body: JSON.parse(String(opts.body)),
      };
      return { id: 'email_123' };
    });
    expect(await p.send(message)).toEqual({ outcome: 'SUCCESS', httpStatus: 200 });
    expect(seen!.headers.authorization).toBe('Bearer re_test_key_123');
    expect(seen!.headers['idempotency-key']).toBe('delivery-1');
    expect(seen!.body).toEqual({
      from: 'RAIN <alerts@example.com>',
      to: ['owner@example.com'],
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });
  });

  it('treats validation errors as permanent, keeping only the error name (never the raw response)', async () => {
    const { api, provider: p } = provider();
    api.intercept({ path: '/emails', method: 'POST' }).reply(422, {
      name: 'validation_error',
      message: 'The to address owner@example.com is invalid',
    });
    expect(await p.send(message)).toEqual({
      outcome: 'PERMANENT_FAILURE',
      httpStatus: 422,
      error: 'Email provider answered HTTP 422 (validation_error)',
    });
  });

  it('treats rate limits, server errors and network errors as temporary', async () => {
    const { api, provider: p } = provider();
    api.intercept({ path: '/emails', method: 'POST' }).reply(429, {});
    api.intercept({ path: '/emails', method: 'POST' }).reply(502, 'bad gateway');
    api.intercept({ path: '/emails', method: 'POST' }).replyWithError(new Error('socket hang up'));
    expect((await p.send(message)).outcome).toBe('TEMPORARY_FAILURE');
    expect((await p.send(message)).outcome).toBe('TEMPORARY_FAILURE');
    expect(await p.send(message)).toEqual({
      outcome: 'TEMPORARY_FAILURE',
      httpStatus: null,
      error: 'Could not reach the email provider',
    });
  });

  it('reports a missing configuration as a failure, never as delivered', async () => {
    mock = new MockAgent();
    expect(UNCONFIGURED_EMAIL_PROVIDER.configured).toBe(false);
    expect(await UNCONFIGURED_EMAIL_PROVIDER.send(message)).toMatchObject({
      outcome: 'PERMANENT_FAILURE',
      error: expect.stringMatching(/not configured/),
    });
  });
});
