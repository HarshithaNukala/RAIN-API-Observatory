import { MonitorResponseSchema, dataEnvelope } from '@rain/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  monitorChecks,
  monitors,
  type NewMonitorCheckRow,
} from '../../apps/server/src/db/schema.js';
import { classifyCheck } from '../../apps/server/src/monitoring/health.js';
import { createHarness, sqlState, type Harness, type TestUser } from './harness.js';

// Check-history storage (migration 0002). The health logic itself is unit tested; these tests
// prove the table accepts what it produces and rejects inconsistent rows.

let h: Harness;
let user: TestUser;
let monitorId: string;

beforeAll(async () => {
  h = await createHarness();
  user = await h.createUser();
  const res = await user
    .post('/api/v1/monitors', { name: 'Checked', url: 'https://api.example.com/health' })
    .expect(201);
  monitorId = dataEnvelope(MonitorResponseSchema).parse(res.body).data.id;
});

afterAll(async () => {
  await h.close();
});

const criteria = { expectedStatusCode: 200, latencyThresholdMs: 500 };
const insert = (row: Omit<NewMonitorCheckRow, 'monitorId' | 'checkedAt'>) =>
  h.db.insert(monitorChecks).values({ monitorId, checkedAt: new Date(), ...row });

describe('monitor_checks', () => {
  it('stores every classification the health logic produces', async () => {
    const results = [
      classifyCheck({ kind: 'response', statusCode: 200, latencyMs: 120 }, criteria),
      classifyCheck({ kind: 'response', statusCode: 200, latencyMs: 900 }, criteria),
      classifyCheck({ kind: 'response', statusCode: 503, latencyMs: 40 }, criteria),
      classifyCheck({ kind: 'no-response', reason: 'TIMEOUT' }, criteria),
    ];
    for (const result of results) await insert(result);
    const rows = await h.db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitorId));
    expect(rows.map((r) => [r.outcome, r.statusCode, r.latencyMs, r.failureReason])).toEqual(
      expect.arrayContaining([
        ['SUCCESS', 200, 120, null],
        ['DEGRADED', 200, 900, null],
        ['FAILURE', 503, 40, 'UNEXPECTED_STATUS'],
        ['FAILURE', null, null, 'TIMEOUT'],
      ]),
    );
  });

  it.each([
    ['latency without a response', { outcome: 'FAILURE', latencyMs: 30, failureReason: 'TIMEOUT' }],
    [
      'a response without latency',
      { outcome: 'SUCCESS', statusCode: 200, latencyMs: null, failureReason: null },
    ],
    ['a failure without a reason', { outcome: 'FAILURE', statusCode: 500, latencyMs: 10 }],
    [
      'a passing check with a reason',
      { outcome: 'SUCCESS', statusCode: 200, latencyMs: 10, failureReason: 'TIMEOUT' },
    ],
    [
      'a no-response reason with a status code',
      { outcome: 'FAILURE', statusCode: 200, latencyMs: 10, failureReason: 'DNS_ERROR' },
    ],
    [
      'UNEXPECTED_STATUS without a status code',
      { outcome: 'FAILURE', failureReason: 'UNEXPECTED_STATUS' },
    ],
    ['an unknown outcome', { outcome: 'MAYBE', statusCode: 200, latencyMs: 10 }],
    ['an unknown reason', { outcome: 'FAILURE', failureReason: 'GREMLINS' }],
    ['a status code out of range', { outcome: 'SUCCESS', statusCode: 99, latencyMs: 10 }],
    ['a negative latency', { outcome: 'SUCCESS', statusCode: 200, latencyMs: -1 }],
  ])('rejects %s', async (_label, row) => {
    const err = await insert(row as Omit<NewMonitorCheckRow, 'monitorId' | 'checkedAt'>).catch(
      (e: unknown) => e,
    );
    expect(sqlState(err)).toBe('23514'); // check_violation
  });

  it('adds status_changed_at to monitors, NULL until a transition is recorded', async () => {
    const [row] = await h.db.select().from(monitors).where(eq(monitors.id, monitorId));
    expect(row?.statusChangedAt).toBeNull();
  });

  it('deletes check history together with its monitor', async () => {
    await user.delete(`/api/v1/monitors/${monitorId}`).expect(204);
    const [{ count } = { count: -1 }] = await h.db
      .select({ count: sql<number>`count(*)::int` })
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitorId));
    expect(count).toBe(0);
  });

  it('has row-level security and the history indexes', async () => {
    const [table] = await h.db.execute<{ relrowsecurity: boolean }>(
      sql`select relrowsecurity from pg_class where relname = 'monitor_checks'`,
    );
    expect(table?.relrowsecurity).toBe(true);
    const indexes = await h.db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'monitor_checks'`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        'monitor_checks_monitor_checked_idx',
        'monitor_checks_checked_at_idx',
      ]),
    );
  });
});

describe('monitors.allow_mutating_requests (migration 0003)', () => {
  it('is NOT NULL with a database default of false, so existing rows stay without permission', async () => {
    const [column] = await h.db.execute<{ column_default: string; is_nullable: string }>(
      sql`select column_default, is_nullable from information_schema.columns
          where table_name = 'monitors' and column_name = 'allow_mutating_requests'`,
    );
    expect(column).toEqual({ column_default: 'false', is_nullable: 'NO' });
  });

  it('is enforced by the API: no POST monitor without explicit permission', async () => {
    const res = await user
      .post('/api/v1/monitors', {
        name: 'Writer',
        url: 'https://api.example.com/items',
        method: 'POST',
      })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('allowMutatingRequests');

    const created = await user
      .post('/api/v1/monitors', {
        name: 'Writer',
        url: 'https://api.example.com/items',
        method: 'POST',
        allowMutatingRequests: true,
      })
      .expect(201);
    const id = dataEnvelope(MonitorResponseSchema).parse(created.body).data.id;
    const [row] = await h.db.select().from(monitors).where(eq(monitors.id, id));
    expect(row?.allowMutatingRequests).toBe(true);
  });
});
