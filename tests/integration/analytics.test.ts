import {
  AnalyticsOverviewSchema,
  MonitorMetricsSchema,
  MonitorResponseSchema,
  dataEnvelope,
  type CheckFailureReason,
  type MonitorCheckOutcome,
} from '@rain/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { incidents, monitorChecks, monitors } from '../../apps/server/src/db/schema.js';
import { createHarness, type Harness, type TestUser } from './harness.js';

// Analytics on real PostgreSQL: the actual aggregation SQL (FILTER counts, percentile_cont,
// date_bin buckets, incident windows, top-N ordering) and owner scoping, through the HTTP API.
// Runs alone (fileParallelism: false); monitors are cleared between tests.

let h: Harness;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  h = await createHarness({ maxMonitorsPerUser: 200 });
  alice = await h.createUser();
  bob = await h.createUser();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.db.delete(monitors);
});

async function createMonitor(user: TestUser = alice, name = 'Payments') {
  const res = await user
    .post('/api/v1/monitors', { name, url: 'https://api.example.com/health' })
    .expect(201);
  return dataEnvelope(MonitorResponseSchema).parse(res.body).data;
}

/** Inserts a check `minutesAgo` before now. */
async function check(
  monitorId: string,
  minutesAgo: number,
  outcome: MonitorCheckOutcome,
  options: {
    latencyMs?: number | null;
    reason?: CheckFailureReason | null;
    status?: number | null;
  } = {},
) {
  const hasResponse = outcome !== 'FAILURE' || options.reason === 'UNEXPECTED_STATUS';
  await h.db.insert(monitorChecks).values({
    monitorId,
    checkedAt: new Date(Date.now() - minutesAgo * 60_000),
    outcome,
    statusCode: options.status !== undefined ? options.status : hasResponse ? 200 : null,
    latencyMs: options.latencyMs !== undefined ? options.latencyMs : hasResponse ? 100 : null,
    failureReason: options.reason ?? (outcome === 'FAILURE' ? 'TIMEOUT' : null),
  });
}

async function metrics(monitorId: string, range = '24h', user: TestUser = alice) {
  const res = await user.get(`/api/v1/monitors/${monitorId}/metrics?range=${range}`).expect(200);
  return MonitorMetricsSchema.parse(res.body.data);
}

async function overview(range = '24h', user: TestUser = alice) {
  const res = await user.get(`/api/v1/analytics/overview?range=${range}`).expect(200);
  return AnalyticsOverviewSchema.parse(res.body.data);
}

describe('check availability (SQL)', () => {
  it('counts slow expected responses as available, unexpected statuses and timeouts as failures', async () => {
    const m = await createMonitor();
    await check(m.id, 1, 'SUCCESS');
    await check(m.id, 2, 'DEGRADED', { latencyMs: 4000 });
    await check(m.id, 3, 'FAILURE', { reason: 'UNEXPECTED_STATUS', status: 503, latencyMs: 30 });
    await check(m.id, 4, 'FAILURE', { reason: 'TIMEOUT' });
    await check(m.id, 5, 'FAILURE', { reason: 'DNS_ERROR' });
    const { checks } = await metrics(m.id);
    expect(checks).toEqual({
      recorded: 5,
      eligible: 5,
      successful: 2,
      failed: 3,
      slow: 1,
      excluded: 0,
      availabilityPercent: 40,
      failurePercent: 60,
    });
  });

  it('excludes SSRF and configuration refusals; no eligible checks gives null, not 0', async () => {
    const m = await createMonitor();
    await check(m.id, 1, 'FAILURE', { reason: 'BLOCKED_DESTINATION' });
    await check(m.id, 2, 'FAILURE', { reason: 'CONFIGURATION_ERROR' });
    const { checks, failureReasons } = await metrics(m.id);
    expect(checks).toMatchObject({
      recorded: 2,
      eligible: 0,
      excluded: 2,
      availabilityPercent: null,
      failurePercent: null,
    });
    expect(failureReasons.every((r) => r.excludedFromAvailability)).toBe(true);
    await check(m.id, 3, 'SUCCESS');
    expect((await metrics(m.id)).checks.availabilityPercent).toBe(100);
  });

  it('applies the window bounds', async () => {
    const m = await createMonitor();
    await check(m.id, 10, 'SUCCESS');
    await check(m.id, 3 * 24 * 60, 'FAILURE');
    await check(m.id, 40 * 24 * 60, 'FAILURE');
    expect((await metrics(m.id, '24h')).checks.eligible).toBe(1);
    expect((await metrics(m.id, '7d')).checks.eligible).toBe(2);
    expect((await metrics(m.id, '30d')).checks.eligible).toBe(2);
  });
});

describe('latency (SQL)', () => {
  it('uses percentile_cont over responses only; NULL latency never counts as zero', async () => {
    const m = await createMonitor();
    for (let i = 1; i <= 100; i++)
      await check(m.id, (i % 50) + 1, 'SUCCESS', { latencyMs: i * 10 });
    await check(m.id, 1, 'FAILURE', { reason: 'TIMEOUT' });
    await check(m.id, 2, 'FAILURE', { reason: 'UNEXPECTED_STATUS', status: 500, latencyMs: 1000 });
    const { latency } = await metrics(m.id);
    // 101 samples: 10..1000 step 10, plus one more 1000.
    expect(latency.samples).toBe(101);
    expect(latency.minMs).toBe(10);
    expect(latency.maxMs).toBe(1000);
    expect(latency.avgMs).toBeCloseTo((50_500 + 1000) / 101, 1);
    expect(latency.p50Ms).toBe(510);
    expect(latency.p95Ms).toBe(960);
    expect(latency.p99Ms).toBe(1000);
  });

  it('computes P95 per bucket and leaves empty buckets null', async () => {
    const m = await createMonitor();
    await check(m.id, 1, 'SUCCESS', { latencyMs: 100 });
    await check(m.id, 1, 'SUCCESS', { latencyMs: 300 });
    const { series } = await metrics(m.id);
    const withData = series.filter((b) => b.eligible > 0);
    expect(withData).toHaveLength(1);
    expect(withData[0]).toMatchObject({
      avgLatencyMs: 200,
      p95LatencyMs: 290,
      availabilityPercent: 100,
    });
    expect(
      series
        .filter((b) => b.eligible === 0)
        .every((b) => b.avgLatencyMs === null && b.availabilityPercent === null),
    ).toBe(true);
    // Bucket boundaries are hour-aligned in UTC.
    expect(series.every((b) => new Date(b.start).getUTCMinutes() === 0)).toBe(true);
  });
});

describe('incidents (SQL)', () => {
  async function incident(
    monitorId: string,
    startedMinutesAgo: number,
    resolvedMinutesAgo: number | null,
  ) {
    await h.db.insert(incidents).values({
      monitorId,
      ownerId: alice.id,
      title: 'down',
      status: resolvedMinutesAgo === null ? 'OPEN' : 'RESOLVED',
      startedAt: new Date(Date.now() - startedMinutesAgo * 60_000),
      resolvedAt:
        resolvedMinutesAgo === null ? null : new Date(Date.now() - resolvedMinutesAgo * 60_000),
    });
  }

  it('counts by started/resolved time in the window; average uses completed resolutions only', async () => {
    const m = await createMonitor();
    await incident(m.id, 26 * 60, 26 * 60 - 30); // Before the 24h window entirely.
    const other = await createMonitor(alice, 'Other');
    await incident(other.id, 120, 60);
    await incident(m.id, 26 * 60, 30); // Started before, resolved inside.
    await incident(m.id, 10, null); // Open.
    const day = await overview('24h');
    expect(day.incidents).toMatchObject({ opened: 2, resolved: 2, currentlyOpen: 1 });
    expect(day.incidents.averageResolutionMs).toBeCloseTo((60 * 60_000 + 25.5 * 3_600_000) / 2, -2);
    expect(day.topIncidentMonitors.map((t) => t.monitor.name)).toEqual(['Other', 'Payments']);
    const week = await overview('7d');
    expect(week.incidents.opened).toBe(4);
    const opened = week.series.reduce((n, b) => n + b.incidentsOpened, 0);
    expect(opened).toBe(4);
  });
});

describe('ownership (SQL)', () => {
  it("never aggregates another user's monitors, checks or incidents", async () => {
    const mine = await createMonitor(alice, 'Mine');
    const theirs = await createMonitor(bob, 'Theirs');
    await check(mine.id, 1, 'SUCCESS');
    for (let i = 0; i < 5; i++) await check(theirs.id, i + 1, 'FAILURE');
    const view = await overview('24h', alice);
    expect(view.monitors.total).toBe(1);
    expect(view.checks).toMatchObject({ eligible: 1, failed: 0 });
    expect(view.topFailingMonitors).toEqual([]);
    await alice.get(`/api/v1/monitors/${theirs.id}/metrics`).expect(404);
    const bobs = await overview('24h', bob);
    expect(bobs.checks.failed).toBe(5);
  });

  it('works for a user with no monitors', async () => {
    const fresh = await h.createUser();
    const view = await overview('30d', fresh);
    expect(view.monitors.total).toBe(0);
    expect(view.checks.availabilityPercent).toBeNull();
    expect(view.series).toHaveLength(30);
  });

  it('top failing monitors are ordered by failures then name, at most five', async () => {
    for (const [name, failures] of [
      ['B', 2],
      ['A', 2],
      ['C', 3],
      ['D', 1],
      ['E', 1],
      ['F', 1],
    ] as const) {
      const m = await createMonitor(alice, name);
      for (let i = 0; i < failures; i++) await check(m.id, i + 1, 'FAILURE');
    }
    const { topFailingMonitors } = await overview();
    expect(topFailingMonitors.map((t) => t.monitor.name)).toEqual(['C', 'A', 'B', 'D', 'E']);
  });

  it('a deleted monitor’s data disappears from analytics', async () => {
    const m = await createMonitor();
    await check(m.id, 1, 'FAILURE');
    await h.db.delete(monitors).where(eq(monitors.id, m.id));
    expect((await overview()).checks.recorded).toBe(0);
  });
});
