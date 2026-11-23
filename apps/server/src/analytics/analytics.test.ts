import { randomUUID } from 'node:crypto';
import type { CheckFailureReason, MonitorCheckOutcome } from '@rain/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IncidentRow, MonitorRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  createInMemoryAnalyticsRepository,
  percentileCont,
} from '../test-support/in-memory-analytics-repository.js';
import {
  createInMemoryMonitorRepository,
  type InMemoryMonitorRepository,
} from '../test-support/in-memory-monitor-repository.js';
import { createAnalyticsService, type AnalyticsService } from './analytics-service.js';
import { buildSeries, percent, resolveWindow } from './analytics-window.js';

const NOW = new Date('2026-11-19T10:30:00.000Z');
const owner = randomUUID();
const other = randomUUID();

let repo: InMemoryMonitorRepository;
let service: AnalyticsService;

beforeEach(() => {
  repo = createInMemoryMonitorRepository();
  service = createAnalyticsService({
    repository: createInMemoryAnalyticsRepository(repo),
    now: () => NOW,
  });
});

async function monitor(overrides: Partial<MonitorRow> = {}): Promise<MonitorRow> {
  return repo.insert({
    ownerId: owner,
    name: 'Payments',
    url: 'https://api.example.com/health',
    method: 'GET',
    expectedStatusCode: 200,
    timeoutMs: 10_000,
    latencyThresholdMs: 1000,
    checkIntervalSeconds: 60,
    ...overrides,
  });
}

/** Records a check `minutesAgo` before NOW. */
function check(
  m: MonitorRow,
  minutesAgo: number,
  outcome: MonitorCheckOutcome,
  options: {
    latencyMs?: number | null;
    reason?: CheckFailureReason | null;
    status?: number | null;
  } = {},
) {
  const hasResponse = outcome !== 'FAILURE' || options.reason === 'UNEXPECTED_STATUS';
  repo.checks.push({
    id: randomUUID(),
    monitorId: m.id,
    attemptId: randomUUID(),
    source: 'SCHEDULED',
    checkedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    outcome,
    statusCode: options.status !== undefined ? options.status : hasResponse ? 200 : null,
    latencyMs: options.latencyMs !== undefined ? options.latencyMs : hasResponse ? 100 : null,
    failureReason: options.reason ?? (outcome === 'FAILURE' ? 'TIMEOUT' : null),
    errorMessage: null,
    createdAt: NOW,
  });
}

function incident(m: MonitorRow, startedMinutesAgo: number, resolvedMinutesAgo: number | null) {
  const row: IncidentRow = {
    id: randomUUID(),
    monitorId: m.id,
    ownerId: m.ownerId,
    title: `${m.name} is down`,
    description: null,
    severity: 'HIGH',
    status: resolvedMinutesAgo === null ? 'OPEN' : 'RESOLVED',
    startedAt: new Date(NOW.getTime() - startedMinutesAgo * 60_000),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt:
      resolvedMinutesAgo === null ? null : new Date(NOW.getTime() - resolvedMinutesAgo * 60_000),
    triggerCheckId: null,
    resolvedByCheckId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  repo.incidents.push(row);
  return row;
}

describe('time windows', () => {
  it('24h: 24 hourly UTC buckets ending with the current (partial) hour', () => {
    const w = resolveWindow('24h', NOW);
    expect(w.bucketStarts).toHaveLength(24);
    expect(w.from.toISOString()).toBe('2026-11-18T11:00:00.000Z');
    expect(w.bucketStarts.at(-1)!.toISOString()).toBe('2026-11-19T10:00:00.000Z');
    expect(w.to).toEqual(NOW);
  });

  it('7d: 28 six-hour buckets aligned to 00/06/12/18 UTC', () => {
    const w = resolveWindow('7d', NOW);
    expect(w.bucketSeconds).toBe(21_600);
    expect(w.bucketStarts).toHaveLength(28);
    expect(w.bucketStarts.at(-1)!.toISOString()).toBe('2026-11-19T06:00:00.000Z');
    expect(w.from.toISOString()).toBe('2026-11-12T12:00:00.000Z');
  });

  it('30d: 30 daily buckets at midnight UTC', () => {
    const w = resolveWindow('30d', NOW);
    expect(w.bucketStarts).toHaveLength(30);
    expect(w.from.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(w.bucketStarts.every((b) => b.getUTCHours() === 0)).toBe(true);
  });

  it('empty buckets keep zero counts but null availability and latency (never fabricated)', () => {
    const w = resolveWindow('24h', NOW);
    const series = buildSeries(w, [], []);
    expect(series).toHaveLength(24);
    expect(
      series.every(
        (b) => b.eligible === 0 && b.availabilityPercent === null && b.avgLatencyMs === null,
      ),
    ).toBe(true);
    expect(series.at(-1)!.end).toBe(NOW.toISOString());
  });

  it('percent is null without a denominator and keeps three decimals', () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33.333);
    expect(percent(9999, 10_000)).toBe(99.99);
  });
});

describe('percentile_cont reference', () => {
  it('interpolates like PostgreSQL', () => {
    expect(percentileCont([], 0.5)).toBeNull();
    expect(percentileCont([7], 0.95)).toBe(7);
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileCont(hundred, 0.95)).toBeCloseTo(95.05, 10);
    expect(percentileCont(hundred, 0.99)).toBeCloseTo(99.01, 10);
  });
});

describe('availability', () => {
  it('all successful checks: 100%', async () => {
    const m = await monitor();
    for (let i = 0; i < 5; i++) check(m, i * 10, 'SUCCESS');
    const { checks } = await service.monitorMetrics(owner, m.id, '24h');
    expect(checks).toMatchObject({
      eligible: 5,
      successful: 5,
      failed: 0,
      availabilityPercent: 100,
      failurePercent: 0,
    });
  });

  it('mixed results, with slow expected responses counted as available', async () => {
    const m = await monitor();
    check(m, 1, 'SUCCESS');
    check(m, 2, 'DEGRADED', { latencyMs: 4000 });
    check(m, 3, 'FAILURE', { reason: 'UNEXPECTED_STATUS', status: 503, latencyMs: 30 });
    check(m, 4, 'FAILURE', { reason: 'TIMEOUT' });
    const { checks } = await service.monitorMetrics(owner, m.id, '24h');
    expect(checks).toEqual({
      recorded: 4,
      eligible: 4,
      successful: 2,
      failed: 2,
      slow: 1,
      excluded: 0,
      availabilityPercent: 50,
      failurePercent: 50,
    });
  });

  it('only slow successful responses: 100% available, all slow', async () => {
    const m = await monitor();
    for (let i = 0; i < 3; i++) check(m, i, 'DEGRADED', { latencyMs: 5000 });
    const { checks } = await service.monitorMetrics(owner, m.id, '24h');
    expect(checks).toMatchObject({ availabilityPercent: 100, slow: 3, failed: 0 });
  });

  it('only failed checks: 0%, not "No data"', async () => {
    const m = await monitor();
    check(m, 1, 'FAILURE', { reason: 'CONNECTION_ERROR' });
    check(m, 2, 'FAILURE', { reason: 'DNS_ERROR' });
    const { checks, latency } = await service.monitorMetrics(owner, m.id, '24h');
    expect(checks.availabilityPercent).toBe(0);
    expect(latency).toEqual({
      samples: 0,
      avgMs: null,
      minMs: null,
      maxMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    });
  });

  it('excludes SSRF and configuration refusals entirely', async () => {
    const m = await monitor();
    check(m, 1, 'SUCCESS');
    check(m, 2, 'FAILURE', { reason: 'BLOCKED_DESTINATION' });
    check(m, 3, 'FAILURE', { reason: 'CONFIGURATION_ERROR' });
    const { checks, failureReasons } = await service.monitorMetrics(owner, m.id, '24h');
    expect(checks).toMatchObject({
      recorded: 3,
      eligible: 1,
      excluded: 2,
      failed: 0,
      availabilityPercent: 100,
    });
    expect(failureReasons).toEqual([
      { reason: 'BLOCKED_DESTINATION', count: 1, excludedFromAvailability: true },
      { reason: 'CONFIGURATION_ERROR', count: 1, excludedFromAvailability: true },
    ]);
  });

  it('no eligible checks: availability is null ("No data"), never 0%', async () => {
    const m = await monitor();
    check(m, 1, 'FAILURE', { reason: 'BLOCKED_DESTINATION' });
    const withRefusal = await service.monitorMetrics(owner, m.id, '24h');
    expect(withRefusal.checks.availabilityPercent).toBeNull();
    const empty = await monitor({ name: 'Empty' });
    const none = await service.monitorMetrics(owner, empty.id, '24h');
    expect(none.checks).toMatchObject({
      recorded: 0,
      eligible: 0,
      availabilityPercent: null,
      failurePercent: null,
    });
    expect(none.series.every((b) => b.availabilityPercent === null)).toBe(true);
  });

  it('respects the window: older checks are left out', async () => {
    const m = await monitor();
    check(m, 60, 'SUCCESS');
    check(m, 3 * 24 * 60, 'FAILURE');
    expect((await service.monitorMetrics(owner, m.id, '24h')).checks.eligible).toBe(1);
    expect((await service.monitorMetrics(owner, m.id, '7d')).checks).toMatchObject({
      eligible: 2,
      availabilityPercent: 50,
    });
  });

  it('aggregates multiple monitors in the overview, never another user’s', async () => {
    const a = await monitor({ name: 'A' });
    const b = await monitor({ name: 'B' });
    const foreign = await monitor({ name: 'Foreign', ownerId: other });
    check(a, 1, 'SUCCESS');
    check(a, 2, 'SUCCESS');
    check(b, 1, 'FAILURE');
    for (let i = 0; i < 10; i++) check(foreign, i, 'FAILURE');
    const overview = await service.overview(owner, '24h');
    expect(overview.checks).toMatchObject({
      eligible: 3,
      successful: 2,
      failed: 1,
      availabilityPercent: 66.667,
    });
    expect(overview.topFailingMonitors.map((t) => t.monitor.name)).toEqual(['B']);
  });
});

describe('latency', () => {
  it('avg, min, max and exact percentiles over responses only (NULL is never zero)', async () => {
    const m = await monitor();
    for (let i = 1; i <= 100; i++) check(m, i, 'SUCCESS', { latencyMs: i * 10 });
    check(m, 101, 'FAILURE', { reason: 'TIMEOUT' });
    check(m, 102, 'FAILURE', { reason: 'CONNECTION_ERROR' });
    const { latency } = await service.monitorMetrics(owner, m.id, '24h');
    expect(latency).toEqual({
      samples: 100,
      avgMs: 505,
      minMs: 10,
      maxMs: 1000,
      p50Ms: 505,
      p95Ms: 950.5,
      p99Ms: 990.1,
    });
  });

  it('includes unexpected statuses that received a response', async () => {
    const m = await monitor();
    check(m, 1, 'SUCCESS', { latencyMs: 100 });
    check(m, 2, 'FAILURE', { reason: 'UNEXPECTED_STATUS', status: 500, latencyMs: 900 });
    const { latency } = await service.monitorMetrics(owner, m.id, '24h');
    expect(latency).toMatchObject({ samples: 2, avgMs: 500, maxMs: 900 });
  });

  it('computes P95 per bucket, never by averaging other percentiles', async () => {
    const m = await monitor();
    // Two checks in the 09:00 bucket, one in the 10:00 bucket.
    check(m, 80, 'SUCCESS', { latencyMs: 100 });
    check(m, 85, 'SUCCESS', { latencyMs: 300 });
    check(m, 5, 'SUCCESS', { latencyMs: 1000 });
    const { series, latency } = await service.monitorMetrics(owner, m.id, '24h');
    const nine = series.find((b) => b.start === '2026-11-19T09:00:00.000Z')!;
    const ten = series.find((b) => b.start === '2026-11-19T10:00:00.000Z')!;
    expect(nine).toMatchObject({
      eligible: 2,
      avgLatencyMs: 200,
      p95LatencyMs: 290,
      availabilityPercent: 100,
    });
    expect(ten).toMatchObject({ eligible: 1, avgLatencyMs: 1000, p95LatencyMs: 1000 });
    expect(latency.p95Ms).toBe(930);
    expect(series.filter((b) => b.eligible === 0).every((b) => b.p95LatencyMs === null)).toBe(true);
  });
});

describe('failures', () => {
  it('breaks failures down by the existing reason vocabulary, deterministically', async () => {
    const m = await monitor();
    check(m, 1, 'FAILURE', { reason: 'TIMEOUT' });
    check(m, 2, 'FAILURE', { reason: 'TIMEOUT' });
    check(m, 3, 'FAILURE', { reason: 'DNS_ERROR' });
    check(m, 4, 'FAILURE', { reason: 'CONNECTION_ERROR' });
    const { failureReasons } = await service.monitorMetrics(owner, m.id, '24h');
    expect(failureReasons.map((r) => [r.reason, r.count])).toEqual([
      ['TIMEOUT', 2],
      ['CONNECTION_ERROR', 1],
      ['DNS_ERROR', 1],
    ]);
  });

  it('ranks monitors by failures, then name, at most five', async () => {
    const names = ['F', 'E', 'D', 'C', 'B', 'A'];
    for (const [i, name] of names.entries()) {
      const m = await monitor({ name });
      for (let k = 0; k <= (i < 2 ? 3 : 1); k++) check(m, k + 1, 'FAILURE');
    }
    const quiet = await monitor({ name: 'Quiet' });
    check(quiet, 1, 'SUCCESS');
    const { topFailingMonitors } = await service.overview(owner, '24h');
    expect(topFailingMonitors.map((t) => [t.monitor.name, t.failed])).toEqual([
      ['E', 4],
      ['F', 4],
      ['A', 2],
      ['B', 2],
      ['C', 2],
    ]);
  });
});

describe('incidents', () => {
  it('counts opened and resolved in the window, and currently open regardless of window', async () => {
    const m = await monitor();
    incident(m, 3 * 24 * 60, null); // Opened 3 days ago, still open.
    incident(m, 120, 60); // Opened and resolved in the last 24h: 60 minutes.
    incident(m, 26 * 60, 30); // Opened before the 24h window, resolved inside it: 25.5 h.
    const day = await service.monitorMetrics(owner, m.id, '24h');
    expect(day.incidents).toEqual({
      opened: 1,
      resolved: 2,
      currentlyOpen: 1,
      averageResolutionMs: Math.round((60 * 60_000 + 25.5 * 3600_000) / 2),
    });
    const week = await service.monitorMetrics(owner, m.id, '7d');
    expect(week.incidents.opened).toBe(3);
  });

  it('never counts an open incident as a resolution time; no incidents → nulls and zeros', async () => {
    const m = await monitor();
    incident(m, 30, null);
    const open = await service.monitorMetrics(owner, m.id, '24h');
    expect(open.incidents).toMatchObject({
      opened: 1,
      resolved: 0,
      currentlyOpen: 1,
      averageResolutionMs: null,
    });
    const quiet = await monitor({ name: 'Quiet' });
    const none = await service.monitorMetrics(owner, quiet.id, '30d');
    expect(none.incidents).toEqual({
      opened: 0,
      resolved: 0,
      currentlyOpen: 0,
      averageResolutionMs: null,
    });
  });

  it('places opened and resolved incidents in their buckets', async () => {
    const m = await monitor();
    incident(m, 80, 10);
    const { series } = await service.monitorMetrics(owner, m.id, '24h');
    expect(series.find((b) => b.start === '2026-11-19T09:00:00.000Z')).toMatchObject({
      incidentsOpened: 1,
      incidentsResolved: 0,
    });
    expect(series.find((b) => b.start === '2026-11-19T10:00:00.000Z')).toMatchObject({
      incidentsOpened: 0,
      incidentsResolved: 1,
    });
  });

  it('ranks monitors by incidents in the window', async () => {
    const a = await monitor({ name: 'A' });
    const b = await monitor({ name: 'B' });
    incident(a, 100, 90);
    incident(b, 50, 40);
    incident(b, 20, null);
    incident(a, 40 * 24 * 60, 40 * 24 * 60 - 5); // Outside 30 days.
    const { topIncidentMonitors, incidents } = await service.overview(owner, '30d');
    expect(topIncidentMonitors.map((t) => [t.monitor.name, t.incidents])).toEqual([
      ['B', 2],
      ['A', 1],
    ]);
    expect(incidents).toMatchObject({ opened: 3, resolved: 2, currentlyOpen: 1 });
  });
});

describe('overview and ownership', () => {
  it('counts monitors by current health, with paused ones separate', async () => {
    await monitor({ currentStatus: 'HEALTHY' });
    await monitor({ currentStatus: 'HEALTHY' });
    await monitor({ currentStatus: 'DEGRADED' });
    await monitor({ currentStatus: 'DOWN' });
    await monitor({ currentStatus: 'DOWN', enabled: false });
    await monitor({});
    await monitor({ ownerId: other, currentStatus: 'DOWN' });
    const { monitors } = await service.overview(owner, '24h');
    expect(monitors).toEqual({ total: 6, healthy: 2, degraded: 1, down: 1, unknown: 1, paused: 1 });
  });

  it('works for a user with no monitors', async () => {
    const overview = await service.overview(randomUUID(), '7d');
    expect(overview.monitors.total).toBe(0);
    expect(overview.checks.availabilityPercent).toBeNull();
    expect(overview.series).toHaveLength(28);
    expect(overview.topFailingMonitors).toEqual([]);
    expect(overview.window).toMatchObject({
      range: '7d',
      bucketSeconds: 21_600,
      to: NOW.toISOString(),
    });
  });

  it("returns MONITOR_NOT_FOUND for someone else's monitor", async () => {
    const foreign = await monitor({ ownerId: other });
    check(foreign, 1, 'SUCCESS');
    const err = await service.monitorMetrics(owner, foreign.id, '24h').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 404, code: 'MONITOR_NOT_FOUND' });
  });

  it('includes paused monitors’ recorded history (it was observed) in metrics', async () => {
    const m = await monitor({ enabled: false });
    check(m, 1, 'SUCCESS');
    const metrics = await service.monitorMetrics(owner, m.id, '24h');
    expect(metrics.monitor.enabled).toBe(false);
    expect(metrics.checks.eligible).toBe(1);
  });
});
