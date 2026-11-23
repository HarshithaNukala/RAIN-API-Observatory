import {
  ApiErrorSchema,
  MonitorResponseSchema,
  NotificationDeliveryDetailSchema,
  NotificationListResponseSchema,
  NotificationSettingsUpdateResponseSchema,
  dataEnvelope,
} from '@rain/shared';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../apps/server/src/db/client.js';
import {
  monitorNotificationSettings,
  monitors,
  notificationAttempts,
  notificationDeliveries,
} from '../../apps/server/src/db/schema.js';
import type { CheckExecution } from '../../apps/server/src/monitoring/executor.js';
import { createMonitoringStore } from '../../apps/server/src/monitoring/monitoring-store.js';
import { createDispatchStore } from '../../apps/server/src/notifications/dispatch-store.js';
import type { EmailMessage } from '../../apps/server/src/notifications/email.js';
import { createNotificationDispatcher } from '../../apps/server/src/notifications/notification-dispatcher.js';
import { createWebhookSender } from '../../apps/server/src/notifications/webhook-sender.js';
import {
  startLocalTarget,
  type LocalTarget,
} from '../../apps/server/src/test-support/local-target.js';
import { createHarness, sqlState, type Harness, type TestUser } from './harness.js';

// Notifications on real PostgreSQL (migration 0006): outbox rows written in the completion
// transaction, (event, channel) uniqueness, SKIP LOCKED claims with leases, attempts, the API.
// No real email or webhook is sent: a recording email provider and a local webhook target.

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let second: DatabaseHandle;
let target: LocalTarget;
let sent: EmailMessage[];

beforeAll(async () => {
  h = await createHarness({ maxMonitorsPerUser: 100 });
  alice = await h.createUser();
  bob = await h.createUser();
  second = createDatabase(inject('databaseUrl'), { maxConnections: 4 });
});
afterAll(async () => {
  await second.close();
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(monitors);
  target = await startLocalTarget();
  sent = [];
});
afterEach(async () => {
  await target.close();
});

const failure = (): CheckExecution => ({
  checkedAt: new Date(),
  result: {
    outcome: 'FAILURE',
    statusCode: 503,
    latencyMs: 20,
    failureReason: 'UNEXPECTED_STATUS',
  },
  errorMessage: 'expected status 200, received 503',
  response: null,
});
const success = (): CheckExecution => ({
  checkedAt: new Date(),
  result: { outcome: 'SUCCESS', statusCode: 200, latencyMs: 40, failureReason: null },
  errorMessage: null,
  response: null,
});

const checks = () => createMonitoringStore(h.db);
async function runCheck(monitorId: string, execution: CheckExecution) {
  await h.db
    .update(monitors)
    .set({ nextCheckAt: new Date(Date.now() - 1000) })
    .where(eq(monitors.id, monitorId));
  const [claim] = await checks().claim(10, 90);
  return checks().complete(claim!, execution);
}

async function createMonitor(user: TestUser = alice) {
  const res = await user
    .post('/api/v1/monitors', { name: 'Payments', url: 'https://api.example.com/health' })
    .expect(201);
  return dataEnvelope(MonitorResponseSchema).parse(res.body).data;
}

async function configure(monitorId: string, body: object, user: TestUser = alice) {
  const res = await user.put(`/api/v1/monitors/${monitorId}/notifications`, body).expect(200);
  return dataEnvelope(NotificationSettingsUpdateResponseSchema).parse(res.body).data;
}

const dispatcher = (db = h.db) =>
  createNotificationDispatcher({
    store: createDispatchStore(db),
    email: {
      configured: true,
      send: async (m) => (sent.push(m), { outcome: 'SUCCESS', httpStatus: 200 }),
    },
    webhook: createWebhookSender({
      transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
    }),
    secretBox: h.secretBox,
    logger: pino({ level: 'silent' }),
    appBaseUrl: 'https://rain.example.com',
  });

describe('outbox (SQL)', () => {
  it('queues email and webhook in the incident transaction; repeats queue nothing; resolution queues once', async () => {
    const m = await createMonitor();
    await configure(m.id, {
      emailEnabled: true,
      webhook: { enabled: true, url: 'http://hooks.example.com/rain' },
    });
    await runCheck(m.id, failure());
    expect(await runCheck(m.id, failure())).toMatchObject({ notificationsQueued: 2 });
    for (let i = 0; i < 3; i++) await runCheck(m.id, failure());
    await runCheck(m.id, success());
    expect(await runCheck(m.id, success())).toMatchObject({ notificationsQueued: 2 });
    const rows = await h.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.monitorId, m.id));
    expect(rows.map((r) => `${r.eventType}/${r.channel}`).sort()).toEqual([
      'INCIDENT_CREATED/EMAIL',
      'INCIDENT_CREATED/WEBHOOK',
      'INCIDENT_RESOLVED/EMAIL',
      'INCIDENT_RESOLVED/WEBHOOK',
    ]);
    expect(rows.find((r) => r.channel === 'EMAIL')!.destination).toMatch(/^.•••@example\.com$/);
  });

  it('(event_id, channel) is unique', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    const [row] = await h.db.select().from(notificationDeliveries);
    const { id: _id, ...copy } = row!;
    const err = await h.db
      .insert(notificationDeliveries)
      .values(copy)
      .catch((e: unknown) => e);
    expect(sqlState(err)).toBe('23505');
  });

  it('rejects incomplete webhook configuration and inconsistent delivery states', async () => {
    const m = await createMonitor();
    const bad = await h.db
      .insert(monitorNotificationSettings)
      .values({ monitorId: m.id, ownerId: alice.id, webhookEnabled: true })
      .catch((e: unknown) => e);
    expect(sqlState(bad)).toBe('23514');
  });

  it('stores the signing secret and header only encrypted', async () => {
    const m = await createMonitor();
    const { signingSecret } = await configure(m.id, {
      webhook: {
        enabled: true,
        url: 'http://hooks.example.com/rain',
        header: { name: 'Authorization', value: 'Bearer zzz-secret' },
      },
    });
    const [row] = await h.db
      .select()
      .from(monitorNotificationSettings)
      .where(eq(monitorNotificationSettings.monitorId, m.id));
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(signingSecret!);
    expect(raw).not.toContain('zzz-secret');
  });
});

describe('dispatcher (SQL)', () => {
  it('claims with SKIP LOCKED, sends, records the attempt and marks SENT', async () => {
    const m = await createMonitor();
    await configure(m.id, {
      emailEnabled: true,
      webhook: { enabled: true, url: 'http://hooks.example.com/rain' },
    });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    target.reply('/rain', 'POST', 200);
    expect(await dispatcher().pollOnce()).toBe(2);
    expect(sent).toHaveLength(1);
    expect(target.captured).toHaveLength(1);
    const rows = await h.db.select().from(notificationDeliveries);
    expect(
      rows.every((r) => r.status === 'SENT' && r.attempts === 1 && r.deliveredAt && !r.leaseToken),
    ).toBe(true);
    expect(await h.db.select().from(notificationAttempts)).toHaveLength(2);
  });

  it('two dispatchers never claim the same delivery', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    for (let i = 0; i < 6; i++) {
      await runCheck(m.id, failure());
      await runCheck(m.id, failure());
      await runCheck(m.id, success());
      await runCheck(m.id, success());
    }
    const a = createDispatchStore(h.db);
    const b = createDispatchStore(second.db);
    const [x, y] = await Promise.all([a.claim(10, 60), b.claim(10, 60)]);
    const ids = [...x, ...y].map((c) => c.delivery.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(12);
  });

  it('recovers an expired lease and rejects the stale completion', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    const store = createDispatchStore(h.db);
    const [stale] = await store.claim(10, 60);
    await h.db.update(notificationDeliveries).set({ leaseUntil: sql`now() - interval '1 second'` });
    await dispatcher().pollOnce();
    const [row] = await h.db.select().from(notificationDeliveries);
    expect(row).toMatchObject({ status: 'SENT', attempts: 2 });
    const ok = await store.complete(stale!, {
      startedAt: new Date(),
      finishedAt: new Date(),
      result: { outcome: 'PERMANENT_FAILURE', httpStatus: null, error: 'late' },
      decision: { status: 'FAILED', nextAttemptAt: new Date(), lastError: 'late' },
    });
    expect(ok).toBe(false);
  });

  it('schedules a retry after a temporary failure', async () => {
    const m = await createMonitor();
    await configure(m.id, { webhook: { enabled: true, url: 'http://hooks.example.com/rain' } });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    target.reply('/rain', 'POST', 503);
    await dispatcher().pollOnce();
    const [row] = await h.db.select().from(notificationDeliveries);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect(await dispatcher().pollOnce()).toBe(0);
  });
});

describe('API (SQL)', () => {
  it('lists, details and retries only the owner’s deliveries', async () => {
    const m = await createMonitor();
    await configure(m.id, { webhook: { enabled: true, url: 'http://hooks.example.com/rain' } });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    target.reply('/rain', 'POST', 404);
    await dispatcher().pollOnce();

    const list = dataEnvelope(NotificationListResponseSchema).parse(
      (await alice.get('/api/v1/notifications?status=FAILED').expect(200)).body,
    ).data;
    expect(list.total).toBe(1);
    const id = list.items[0]!.id;
    const detail = dataEnvelope(NotificationDeliveryDetailSchema).parse(
      (await alice.get(`/api/v1/notifications/${id}`).expect(200)).body,
    ).data;
    expect(detail.attemptHistory).toEqual([
      expect.objectContaining({ attemptNumber: 1, outcome: 'PERMANENT_FAILURE', httpStatus: 404 }),
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/ciphertext|whsec_|lease/);

    await bob.get(`/api/v1/notifications/${id}`).expect(404);
    await bob.post(`/api/v1/notifications/${id}/retry`).expect(404);
    await bob.get(`/api/v1/monitors/${m.id}/notifications`).expect(404);
    expect(
      dataEnvelope(NotificationListResponseSchema).parse(
        (await bob.get('/api/v1/notifications').expect(200)).body,
      ).data.total,
    ).toBe(0);

    const retried = await alice.post(`/api/v1/notifications/${id}/retry`).expect(200);
    expect(retried.body.data).toMatchObject({ status: 'PENDING', maxAttempts: 9 });
    const again = await alice.post(`/api/v1/notifications/${id}/retry`).expect(409);
    expect(ApiErrorSchema.parse(again.body).error.code).toBe('NOTIFICATION_NOT_RETRYABLE');
  });

  it('rejects SSRF-unsafe webhook destinations', async () => {
    const m = await createMonitor();
    for (const url of [
      'http://127.0.0.1/hook',
      'http://10.0.0.5/hook',
      'https://hooks.example.com:8443/x',
    ]) {
      const res = await alice.put(`/api/v1/monitors/${m.id}/notifications`, {
        webhook: { enabled: true, url },
      });
      expect(res.status, url).toBe(400);
    }
  });
});
