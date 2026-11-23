import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MonitorNotificationSettingsRow } from '../db/schema.js';
import {
  classifyHttpStatus,
  decideAfterAttempt,
  maskEmail,
  planDeliveries,
  retryDelayMs,
  webhookDestination,
  type IncidentEventSnapshot,
} from './notification-rules.js';

const at = new Date('2026-11-19T10:00:00.000Z');
const event: IncidentEventSnapshot = {
  eventId: randomUUID(),
  eventType: 'INCIDENT_CREATED',
  occurredAt: at,
  incident: {
    id: randomUUID(),
    title: 'Payments is down',
    severity: 'HIGH',
    status: 'OPEN',
    summary: 'Detected automatically after 2 consecutive failed checks.',
    startedAt: at,
    resolvedAt: null,
  },
  monitor: { id: randomUUID(), name: 'Payments' },
  ownerId: randomUUID(),
};

function settings(
  overrides: Partial<MonitorNotificationSettingsRow> = {},
): MonitorNotificationSettingsRow {
  return {
    monitorId: event.monitor.id,
    ownerId: event.ownerId,
    emailEnabled: false,
    webhookEnabled: false,
    webhookUrl: null,
    webhookSecretCiphertext: null,
    webhookSecretIv: null,
    webhookSecretAuthTag: null,
    webhookSecretKeyVersion: null,
    webhookHeaderName: null,
    webhookHeaderCiphertext: null,
    webhookHeaderIv: null,
    webhookHeaderAuthTag: null,
    webhookHeaderKeyVersion: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
const webhook = {
  webhookEnabled: true,
  webhookUrl: 'https://hooks.example.com/rain?token=should-not-show',
  webhookSecretCiphertext: 'c',
  webhookSecretIv: 'i',
  webhookSecretAuthTag: 't',
  webhookSecretKeyVersion: 1,
};

describe('planDeliveries', () => {
  it('queues nothing without settings or with every channel off', () => {
    expect(planDeliveries(undefined, 'a@b.co', event)).toEqual([]);
    expect(planDeliveries(settings(), 'a@b.co', event)).toEqual([]);
  });

  it('queues one row per enabled and configured channel, with a safe payload and destination', () => {
    const rows = planDeliveries(
      settings({ emailEnabled: true, ...webhook }),
      'prajit@example.com',
      event,
    );
    expect(rows.map((r) => [r.channel, r.destination])).toEqual([
      ['EMAIL', 'p•••@example.com'],
      ['WEBHOOK', 'hooks.example.com'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        eventId: event.eventId,
        eventType: 'INCIDENT_CREATED',
        status: 'PENDING',
      });
      expect(JSON.stringify(r.payload)).not.toContain('token');
      expect(r.payload).toEqual({
        eventId: event.eventId,
        eventType: 'INCIDENT_CREATED',
        occurredAt: at.toISOString(),
        incident: { ...event.incident, startedAt: at.toISOString(), resolvedAt: null },
        monitor: event.monitor,
      });
    }
  });

  it('skips email when the account has no address, and a webhook that is disabled', () => {
    expect(planDeliveries(settings({ emailEnabled: true }), null, event)).toEqual([]);
    expect(planDeliveries(settings({ ...webhook, webhookEnabled: false }), null, event)).toEqual(
      [],
    );
  });
});

describe('destinations', () => {
  it('masks email addresses and shows only the webhook host', () => {
    expect(maskEmail('prajit@example.com')).toBe('p•••@example.com');
    expect(maskEmail('nope')).toBe('•••');
    expect(webhookDestination('https://user:pw@hooks.example.com:443/a/b?secret=1')).toBe(
      'hooks.example.com',
    );
  });
});

describe('retry policy', () => {
  it('grows exponentially with equal jitter, capped at 6 hours', () => {
    expect(retryDelayMs(1, () => 0)).toBe(15_000);
    expect(retryDelayMs(1, () => 1)).toBe(30_000);
    expect(retryDelayMs(2, () => 0)).toBe(30_000);
    expect(retryDelayMs(4, () => 1)).toBe(240_000);
    expect(retryDelayMs(20, () => 1)).toBe(6 * 3600_000);
    for (let n = 1; n <= 8; n++) {
      const nominal = Math.min(6 * 3600_000, 30_000 * 2 ** (n - 1));
      const d = retryDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(nominal / 2);
      expect(d).toBeLessThanOrEqual(nominal);
    }
  });

  it.each([
    [200, 'SUCCESS'],
    [204, 'SUCCESS'],
    [301, 'PERMANENT_FAILURE'],
    [400, 'PERMANENT_FAILURE'],
    [401, 'PERMANENT_FAILURE'],
    [404, 'PERMANENT_FAILURE'],
    [408, 'TEMPORARY_FAILURE'],
    [429, 'TEMPORARY_FAILURE'],
    [500, 'TEMPORARY_FAILURE'],
    [503, 'TEMPORARY_FAILURE'],
  ] as const)('HTTP %i is %s', (status, expected) => {
    expect(classifyHttpStatus(status)).toBe(expected);
  });

  it('SENT on success; PENDING with a delay on a temporary failure; FAILED when exhausted or permanent', () => {
    expect(decideAfterAttempt({ outcome: 'SUCCESS', httpStatus: 200 }, 1, 8, at)).toEqual({
      status: 'SENT',
      deliveredAt: at,
      nextAttemptAt: at,
      lastError: null,
    });
    const temp = {
      outcome: 'TEMPORARY_FAILURE',
      httpStatus: 503,
      error: 'Webhook x answered HTTP 503',
    } as const;
    expect(decideAfterAttempt(temp, 3, 8, at, () => 1)).toEqual({
      status: 'PENDING',
      nextAttemptAt: new Date(at.getTime() + 120_000),
      lastError: 'Webhook x answered HTTP 503',
    });
    expect(decideAfterAttempt(temp, 8, 8, at)).toMatchObject({
      status: 'FAILED',
      lastError: 'Webhook x answered HTTP 503 (gave up after 8 attempts)',
    });
    expect(
      decideAfterAttempt(
        { outcome: 'PERMANENT_FAILURE', httpStatus: 404, error: 'gone' },
        1,
        8,
        at,
      ),
    ).toMatchObject({ status: 'FAILED', lastError: 'gone' });
  });
});
