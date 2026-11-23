import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  ManualCheckQueuedSchema,
  MonitorCheckListResponseSchema,
  MonitorResponseSchema,
  dataEnvelope,
} from '@rain/shared';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../apps/server/src/db/client.js';
import { monitorChecks, monitors } from '../../apps/server/src/db/schema.js';
import type { CheckExecution } from '../../apps/server/src/monitoring/executor.js';
import { createMonitorExecutor } from '../../apps/server/src/monitoring/executor.js';
import {
  createMonitoringStore,
  type MonitoringStore,
} from '../../apps/server/src/monitoring/monitoring-store.js';
import { createMonitoringWorker } from '../../apps/server/src/monitoring/worker-engine.js';
import {
  startLocalTarget,
  type LocalTarget,
} from '../../apps/server/src/test-support/local-target.js';
import { createHarness, sqlState, type Harness, type TestUser } from './harness.js';

// The monitoring engine against real PostgreSQL (migration 0004): claims with FOR UPDATE SKIP
// LOCKED, lease tokens, the completion transaction, idempotent attempts, and the manual-check API.
// This file runs alone (fileParallelism: false) and clears monitors between tests, because claims
// are global by design.

let h: Harness;
let user: TestUser;
let store: MonitoringStore;
let second: DatabaseHandle;
let otherStore: MonitoringStore;

beforeAll(async () => {
  h = await createHarness({ maxMonitorsPerUser: 200 });
  user = await h.createUser();
  store = createMonitoringStore(h.db);
  second = createDatabase(inject('databaseUrl'), { maxConnections: 4 });
  otherStore = createMonitoringStore(second.db);
});

afterAll(async () => {
  await second.close();
  await h.close();
});

beforeEach(async () => {
  await h.db.delete(monitors);
});

const ok = (latencyMs = 80): CheckExecution => ({
  checkedAt: new Date(),
  result: { outcome: 'SUCCESS', statusCode: 200, latencyMs, failureReason: null },
  errorMessage: null,
  response: null,
});
const noResponse = (
  reason: 'TIMEOUT' | 'BLOCKED_DESTINATION' | 'CONNECTION_ERROR',
): CheckExecution => ({
  checkedAt: new Date(),
  result: { outcome: 'FAILURE', statusCode: null, latencyMs: null, failureReason: reason },
  errorMessage: `GET http://api.example.com/health: ${reason}`,
  response: null,
});

async function createMonitor(body: object = {}) {
  const res = await user
    .post('/api/v1/monitors', {
      name: 'Engine',
      url: 'http://api.example.com/health',
      checkIntervalSeconds: 60,
      ...body,
    })
    .expect(201);
  return dataEnvelope(MonitorResponseSchema).parse(res.body).data;
}
const row = async (id: string) =>
  (await h.db.select().from(monitors).where(eq(monitors.id, id)))[0]!;
const checks = (id: string) =>
  h.db.select().from(monitorChecks).where(eq(monitorChecks.monitorId, id));
const setRow = (id: string, values: Partial<typeof monitors.$inferInsert>) =>
  h.db.update(monitors).set(values).where(eq(monitors.id, id));
const dbNow = async () =>
  (await h.db.execute<{ now: string }>(sql`select now()::text as now`))[0]!.now;

describe('schema (migration 0004)', () => {
  it('requires lease_until and lease_token together', async () => {
    const m = await createMonitor();
    const err = await setRow(m.id, { leaseUntil: new Date() }).catch((e: unknown) => e);
    expect(sqlState(err)).toBe('23514');
  });

  it('accepts only SCHEDULED or MANUAL as check source, and attempt IDs are unique', async () => {
    const m = await createMonitor();
    const base = {
      monitorId: m.id,
      checkedAt: new Date(),
      outcome: 'SUCCESS',
      statusCode: 200,
      latencyMs: 5,
    };
    const bad = await h.db
      .insert(monitorChecks)
      .values({ ...base, source: 'CRON' })
      .catch((e: unknown) => e);
    expect(sqlState(bad)).toBe('23514');
    const attemptId = randomUUID();
    await h.db.insert(monitorChecks).values({ ...base, attemptId });
    const dup = await h.db
      .insert(monitorChecks)
      .values({ ...base, attemptId })
      .catch((e: unknown) => e);
    expect(sqlState(dup)).toBe('23505');
  });

  it('accepts the CONFIGURATION_ERROR reason with no response', async () => {
    const m = await createMonitor();
    await h.db.insert(monitorChecks).values({
      monitorId: m.id,
      checkedAt: new Date(),
      outcome: 'FAILURE',
      failureReason: 'CONFIGURATION_ERROR',
    });
    expect(await checks(m.id)).toHaveLength(1);
  });
});

describe('claiming', () => {
  it('leases a due monitor with a fresh token, and a live lease blocks a second claim', async () => {
    const m = await createMonitor();
    const [claim] = await store.claim(10, 90);
    expect(claim).toMatchObject({ due: true, manualRequestedAt: null });
    expect(claim!.monitor.id).toBe(m.id);
    const stored = await row(m.id);
    expect(stored.leaseToken).toBe(claim!.leaseToken);
    expect(stored.leaseUntil!.getTime() - claim!.claimedAt.getTime()).toBeCloseTo(90_000, -2);
    expect(await store.claim(10, 90)).toHaveLength(0);
    expect(await otherStore.claim(10, 90)).toHaveLength(0);
  });

  it('never claims paused monitors or monitors not yet due', async () => {
    const paused = await createMonitor({ name: 'paused' });
    await user.post(`/api/v1/monitors/${paused.id}/pause`).expect(200);
    const future = await createMonitor({ name: 'future' });
    await setRow(future.id, { nextCheckAt: new Date(Date.now() + 60_000) });
    expect(await store.claim(10, 90)).toHaveLength(0);
  });

  it('re-claims a monitor whose lease expired (crashed worker), with a new token', async () => {
    const m = await createMonitor();
    const [first] = await store.claim(10, 90);
    await setRow(m.id, { leaseUntil: new Date(Date.now() - 1000) });
    const [again] = await otherStore.claim(10, 90);
    expect(again!.monitor.id).toBe(m.id);
    expect(again!.leaseToken).not.toBe(first!.leaseToken);
  });

  it('SKIP LOCKED: a row locked by another transaction is skipped, not waited for', async () => {
    const m = await createMonitor();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const tx = second.db.transaction(async (t) => {
      await t.select().from(monitors).where(eq(monitors.id, m.id)).for('update');
      locked();
      await held;
    });
    await isLocked;
    const started = Date.now();
    expect(await store.claim(10, 90)).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(2000);
    release();
    await tx;
    expect(await store.claim(10, 90)).toHaveLength(1);
  });

  it('concurrent workers claim disjoint sets', async () => {
    for (let i = 0; i < 30; i++) await createMonitor({ name: `m${i}` });
    const [a, b] = await Promise.all([store.claim(20, 90), otherStore.claim(20, 90)]);
    const ids = [...a, ...b].map((c) => c.monitor.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(30);
  });

  it('bounds a claim by the requested limit', async () => {
    for (let i = 0; i < 5; i++) await createMonitor({ name: `m${i}` });
    expect(await store.claim(2, 90)).toHaveLength(2);
  });

  it('claims queued manual checks first, even if not due', async () => {
    const due = await createMonitor({ name: 'due' });
    await setRow(due.id, { nextCheckAt: new Date(Date.now() - 60_000) });
    const manual = await createMonitor({ name: 'manual' });
    await setRow(manual.id, { nextCheckAt: new Date(Date.now() + 60_000) });
    await user.post(`/api/v1/monitors/${manual.id}/check`).expect(202);
    const [claim] = await store.claim(1, 90);
    expect(claim!.monitor.id).toBe(manual.id);
    expect(claim!.due).toBe(false);
    expect(claim!.manualRequestedAt).toEqual(expect.any(Date));
  });

  it('does not change updated_at (claims are bookkeeping, not edits)', async () => {
    const m = await createMonitor();
    const before = (await row(m.id)).updatedAt;
    const [claim] = await store.claim(10, 90);
    await store.complete(claim!, ok());
    expect((await row(m.id)).updatedAt).toEqual(before);
  });
});

describe('completion transaction', () => {
  it('records the check, applies health, stamps status_changed_at, schedules from the previous slot, clears the lease', async () => {
    const m = await createMonitor();
    const scheduled = new Date(Date.now() - 1000);
    await setRow(m.id, { nextCheckAt: scheduled });
    const [claim] = await store.claim(10, 90);
    const execution = ok(42);
    expect(await store.complete(claim!, execution)).toMatchObject({
      recorded: true,
      status: 'HEALTHY',
      statusChanged: true,
    });
    const stored = await row(m.id);
    expect(stored).toMatchObject({
      currentStatus: 'HEALTHY',
      consecutiveSuccesses: 1,
      leaseUntil: null,
      leaseToken: null,
    });
    expect(stored.statusChangedAt).toEqual(stored.lastCheckedAt);
    expect(stored.nextCheckAt.getTime()).toBe(scheduled.getTime() + 60_000);
    const [check] = await checks(m.id);
    expect(check).toMatchObject({
      source: 'SCHEDULED',
      attemptId: claim!.leaseToken,
      statusCode: 200,
      latencyMs: 42,
    });
  });

  it('first failure → DEGRADED, second → DOWN; no response stores NULL status and latency', async () => {
    const m = await createMonitor();
    for (const expected of ['DEGRADED', 'DOWN']) {
      await setRow(m.id, { nextCheckAt: new Date(Date.now() - 1000) });
      const [claim] = await store.claim(10, 90);
      expect(await store.complete(claim!, noResponse('TIMEOUT'))).toMatchObject({
        status: expected,
      });
    }
    const rows = await checks(m.id);
    expect(rows.every((c) => c.statusCode === null && c.latencyMs === null)).toBe(true);
  });

  it('SSRF rejections are recorded but never mark the monitor DOWN', async () => {
    const m = await createMonitor();
    for (let i = 0; i < 3; i++) {
      await setRow(m.id, { nextCheckAt: new Date(Date.now() - 1000) });
      const [claim] = await store.claim(10, 90);
      expect(await store.complete(claim!, noResponse('BLOCKED_DESTINATION'))).toMatchObject({
        recorded: true,
        healthSkipped: 'HEALTH_NEUTRAL',
      });
    }
    expect(await row(m.id)).toMatchObject({ currentStatus: 'UNKNOWN', consecutiveFailures: 0 });
    expect(await checks(m.id)).toHaveLength(3);
  });

  it('a stale worker cannot overwrite after its lease was re-claimed', async () => {
    const m = await createMonitor();
    const [stale] = await store.claim(10, 90);
    await setRow(m.id, { leaseUntil: new Date(Date.now() - 1000) });
    const [fresh] = await otherStore.claim(10, 90);
    expect(await otherStore.complete(fresh!, ok())).toMatchObject({ recorded: true });
    expect(await store.complete(stale!, noResponse('TIMEOUT'))).toEqual({
      recorded: false,
      reason: 'LEASE_LOST',
    });
    expect(await row(m.id)).toMatchObject({ currentStatus: 'HEALTHY' });
    expect(await checks(m.id)).toHaveLength(1);
  });

  it('a retried completion of the same attempt is a no-op (ON CONFLICT on attempt_id)', async () => {
    const m = await createMonitor();
    const [claim] = await store.claim(10, 90);
    await store.complete(claim!, ok());
    // As if the first commit succeeded but the worker never got the acknowledgement.
    await setRow(m.id, {
      leaseUntil: new Date(Date.now() + 60_000),
      leaseToken: claim!.leaseToken,
    });
    expect(await store.complete(claim!, ok())).toEqual({
      recorded: false,
      reason: 'DUPLICATE_ATTEMPT',
    });
    expect(await checks(m.id)).toHaveLength(1);
  });

  it('pause during the check: history recorded, health untouched', async () => {
    const m = await createMonitor();
    const [claim] = await store.claim(10, 90);
    await user.post(`/api/v1/monitors/${m.id}/pause`).expect(200);
    expect(await store.complete(claim!, noResponse('CONNECTION_ERROR'))).toMatchObject({
      recorded: true,
      healthSkipped: 'PAUSED',
    });
    expect(await row(m.id)).toMatchObject({
      enabled: false,
      currentStatus: 'UNKNOWN',
      consecutiveFailures: 0,
      leaseToken: null,
    });
  });

  it('delete during the check: the result is discarded without errors', async () => {
    const m = await createMonitor();
    const [claim] = await store.claim(10, 90);
    await user.delete(`/api/v1/monitors/${m.id}`).expect(204);
    expect(await store.complete(claim!, ok())).toEqual({
      recorded: false,
      reason: 'MONITOR_DELETED',
    });
  });

  it('release gives the lease back and advances the schedule without a check', async () => {
    const m = await createMonitor();
    const [claim] = await store.claim(10, 90);
    expect(await store.release(claim!)).toBe(true);
    const stored = await row(m.id);
    expect(stored).toMatchObject({ leaseToken: null, leaseUntil: null, currentStatus: 'UNKNOWN' });
    expect(stored.nextCheckAt.getTime()).toBeGreaterThan(Date.parse(await dbNow()));
    expect(await checks(m.id)).toHaveLength(0);
  });
});

describe('manual check API', () => {
  it('POST /check queues in PostgreSQL (202), then the worker records a MANUAL check', async () => {
    const m = await createMonitor();
    await setRow(m.id, { nextCheckAt: new Date(Date.now() + 60_000) });
    const res = await user.post(`/api/v1/monitors/${m.id}/check`).expect(202);
    const queued = dataEnvelope(ManualCheckQueuedSchema).parse(res.body).data;
    expect((await row(m.id)).manualCheckRequestedAt?.toISOString()).toBe(queued.queuedAt);

    const again = await user.post(`/api/v1/monitors/${m.id}/check`).expect(409);
    expect(ApiErrorSchema.parse(again.body).error.code).toBe('CHECK_ALREADY_QUEUED');

    const [claim] = await store.claim(10, 90);
    await store.complete(claim!, ok());
    const stored = await row(m.id);
    expect(stored.manualCheckRequestedAt).toBeNull();
    expect(stored.lastManualCheckAt).toEqual(expect.any(Date));

    const cooldown = await user.post(`/api/v1/monitors/${m.id}/check`).expect(429);
    expect(ApiErrorSchema.parse(cooldown.body).error.code).toBe('CHECK_COOLDOWN');
    expect(cooldown.headers['retry-after']).toMatch(/^\d+$/);

    const history = await user.get(`/api/v1/monitors/${m.id}/checks?source=MANUAL`).expect(200);
    const list = dataEnvelope(MonitorCheckListResponseSchema).parse(history.body).data;
    expect(list.items).toEqual([expect.objectContaining({ source: 'MANUAL', outcome: 'SUCCESS' })]);
  });

  it('rejects paused monitors and other users', async () => {
    const m = await createMonitor();
    const stranger = await h.createUser();
    const notFound = await stranger.post(`/api/v1/monitors/${m.id}/check`).expect(404);
    expect(ApiErrorSchema.parse(notFound.body).error.code).toBe('MONITOR_NOT_FOUND');
    await stranger.get(`/api/v1/monitors/${m.id}/checks`).expect(404);
    await user.post(`/api/v1/monitors/${m.id}/pause`).expect(200);
    const paused = await user.post(`/api/v1/monitors/${m.id}/check`).expect(409);
    expect(ApiErrorSchema.parse(paused.body).error.code).toBe('MONITOR_PAUSED');
  });

  it('GET /checks pages newest first with a cursor', async () => {
    const m = await createMonitor();
    const base = Date.parse('2026-11-18T10:00:00.000Z');
    await h.db.insert(monitorChecks).values(
      Array.from({ length: 5 }, (_, i) => ({
        monitorId: m.id,
        checkedAt: new Date(base + i * 1000),
        outcome: 'SUCCESS',
        statusCode: 200,
        latencyMs: i,
      })),
    );
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const path: string = `/api/v1/monitors/${m.id}/checks?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = dataEnvelope(MonitorCheckListResponseSchema).parse(
        (await user.get(path).expect(200)).body,
      ).data;
      seen.push(...page.items.map((c) => c.latencyMs!));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([4, 3, 2, 1, 0]);
  });
});

describe('worker against PostgreSQL and a local API', () => {
  let target: LocalTarget;
  beforeEach(async () => {
    target = await startLocalTarget();
  });
  afterEach(async () => {
    await target.close();
  });

  it('runs the whole lifecycle with the SSRF-safe transport and decrypted headers', async () => {
    const m = await createMonitor({ headers: [{ name: 'X-Api-Key', value: 'k-123' }] });
    target.reply('/health', 'GET', 200, 'ok');
    const worker = createMonitoringWorker({
      store,
      executor: createMonitorExecutor({
        transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
        secretBox: h.secretBox,
      }),
      logger: pino({ level: 'silent' }),
    });
    expect(await worker.pollOnce()).toBe(1);
    expect(target.captured[0]!.headers['x-api-key']).toBe('k-123');

    const details = await user.get(`/api/v1/monitors/${m.id}`).expect(200);
    expect(dataEnvelope(MonitorResponseSchema).parse(details.body).data).toMatchObject({
      currentStatus: 'HEALTHY',
      lastCheckedAt: expect.any(String),
      statusChangedAt: expect.any(String),
    });
  });
});
