import { HEALTH_NEUTRAL_REASONS, type CheckFailureReason, type MonitorStatus } from '@rain/shared';
import type { IncidentRow, MonitorCheckRow, MonitorRow } from '../db/schema.js';
import type {
  AnalyticsQueries,
  AnalyticsRepository,
  AnalyticsScope,
  TimeRange,
} from '../analytics/analytics-repository.js';
import type { InMemoryMonitorRepository } from './in-memory-monitor-repository.js';

/**
 * TEST ONLY. The analytics repository over an in-memory monitor repository's rows, reproducing
 * the SQL's semantics: owner scoping, eligibility, inclusive time bounds, epoch-aligned UTC
 * buckets (`date_bin`), and PostgreSQL's `percentile_cont` (linear interpolation, NULLs ignored).
 * It lets the service, routes and UI be tested without a database; the SQL itself is verified by
 * tests/integration/analytics.test.ts.
 */

/** PostgreSQL percentile_cont: position (n − 1) × p in the sorted values, interpolated. */
export function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

const eligible = (c: MonitorCheckRow) =>
  c.failureReason === null || !HEALTH_NEUTRAL_REASONS.has(c.failureReason as CheckFailureReason);
const within = (d: Date | null, r: TimeRange) =>
  d !== null && d.getTime() >= r.from.getTime() && d.getTime() <= r.to.getTime();
const bucketOf = (d: Date, seconds: number) =>
  Math.floor(d.getTime() / (seconds * 1000)) * seconds * 1000;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function counts(checks: MonitorCheckRow[]) {
  const e = checks.filter(eligible);
  return {
    recorded: checks.length,
    eligible: e.length,
    successful: e.filter((c) => c.outcome !== 'FAILURE').length,
    failed: e.filter((c) => c.outcome === 'FAILURE').length,
    slow: checks.filter((c) => c.outcome === 'DEGRADED').length,
    excluded: checks.length - e.length,
  };
}

const latencies = (checks: MonitorCheckRow[]) =>
  checks.map((c) => c.latencyMs).filter((v): v is number => v !== null);

const ref = (m: MonitorRow) => ({
  id: m.id,
  name: m.name,
  currentStatus: m.currentStatus as MonitorStatus,
  enabled: m.enabled,
});

const byCountThenName =
  <T extends { name: string; id: string }>(key: (x: T) => number) =>
  (a: T, b: T) =>
    key(b) - key(a) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function createInMemoryAnalyticsRepository(
  repo: InMemoryMonitorRepository,
): AnalyticsRepository {
  const ownedMonitors = (scope: AnalyticsScope) =>
    repo.monitors.filter(
      (m) => m.ownerId === scope.ownerId && (!scope.monitorId || m.id === scope.monitorId),
    );
  const checksIn = (scope: AnalyticsScope, range: TimeRange) => {
    const ids = new Set(ownedMonitors(scope).map((m) => m.id));
    return repo.checks.filter((c) => ids.has(c.monitorId) && within(c.checkedAt, range));
  };
  const incidentsOf = (scope: AnalyticsScope): IncidentRow[] =>
    repo.incidents.filter(
      (i) => i.ownerId === scope.ownerId && (!scope.monitorId || i.monitorId === scope.monitorId),
    );

  const queries: AnalyticsQueries = {
    async findMonitor(ownerId, monitorId) {
      const m = repo.monitors.find((x) => x.id === monitorId && x.ownerId === ownerId);
      return m && ref(m);
    },

    async monitorCounts(ownerId) {
      const mine = repo.monitors.filter((m) => m.ownerId === ownerId);
      const on = (s: string) => mine.filter((m) => m.enabled && m.currentStatus === s).length;
      return {
        total: mine.length,
        healthy: on('HEALTHY'),
        degraded: on('DEGRADED'),
        down: on('DOWN'),
        unknown: on('UNKNOWN'),
        paused: mine.filter((m) => !m.enabled).length,
      };
    },

    async checkTotals(scope, range) {
      const checks = checksIn(scope, range);
      const l = latencies(checks);
      return {
        ...counts(checks),
        latencySamples: l.length,
        avgMs: avg(l),
        minMs: l.length ? Math.min(...l) : null,
        maxMs: l.length ? Math.max(...l) : null,
        p50Ms: percentileCont(l, 0.5),
        p95Ms: percentileCont(l, 0.95),
        p99Ms: percentileCont(l, 0.99),
      };
    },

    async checkBuckets(scope, range, bucketSeconds) {
      const groups = new Map<number, MonitorCheckRow[]>();
      for (const c of checksIn(scope, range)) {
        const b = bucketOf(c.checkedAt, bucketSeconds);
        groups.set(b, [...(groups.get(b) ?? []), c]);
      }
      return [...groups]
        .sort(([a], [b]) => a - b)
        .map(([bucketMs, checks]) => ({
          bucketMs,
          ...counts(checks),
          avgLatencyMs: avg(latencies(checks)),
          p95LatencyMs: percentileCont(latencies(checks), 0.95),
        }));
    },

    async failureReasons(scope, range) {
      const tally = new Map<CheckFailureReason, number>();
      for (const c of checksIn(scope, range)) {
        if (c.failureReason) {
          const r = c.failureReason as CheckFailureReason;
          tally.set(r, (tally.get(r) ?? 0) + 1);
        }
      }
      return [...tally]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    },

    async incidentTotals(scope, range) {
      const all = incidentsOf(scope);
      const resolved = all.filter((i) => within(i.resolvedAt, range));
      return {
        opened: all.filter((i) => within(i.startedAt, range)).length,
        resolved: resolved.length,
        currentlyOpen: all.filter((i) => i.status !== 'RESOLVED').length,
        averageResolutionMs: avg(
          resolved.map((i) => i.resolvedAt!.getTime() - i.startedAt.getTime()),
        ),
      };
    },

    async incidentBuckets(scope, range, bucketSeconds) {
      const rows = new Map<number, { opened: number; resolved: number }>();
      const bump = (d: Date, key: 'opened' | 'resolved') => {
        const b = bucketOf(d, bucketSeconds);
        const row = rows.get(b) ?? { opened: 0, resolved: 0 };
        row[key]++;
        rows.set(b, row);
      };
      for (const i of incidentsOf(scope)) {
        if (within(i.startedAt, range)) bump(i.startedAt, 'opened');
        if (within(i.resolvedAt, range)) bump(i.resolvedAt!, 'resolved');
      }
      return [...rows].sort(([a], [b]) => a - b).map(([bucketMs, r]) => ({ bucketMs, ...r }));
    },

    async topFailingMonitors(ownerId, range, limit) {
      return ownedMonitors({ ownerId })
        .map((m) => ({ ...ref(m), ...counts(checksIn({ ownerId, monitorId: m.id }, range)) }))
        .filter((r) => r.failed > 0)
        .sort(byCountThenName((r) => r.failed))
        .slice(0, limit)
        .map(({ id, name, currentStatus, enabled, failed, eligible: e, successful }) => ({
          id,
          name,
          currentStatus,
          enabled,
          failed,
          eligible: e,
          successful,
        }));
    },

    async topIncidentMonitors(ownerId, range, limit) {
      return ownedMonitors({ ownerId })
        .map((m) => ({
          ...ref(m),
          incidents: incidentsOf({ ownerId, monitorId: m.id }).filter((i) =>
            within(i.startedAt, range),
          ).length,
        }))
        .filter((r) => r.incidents > 0)
        .sort(byCountThenName((r) => r.incidents))
        .slice(0, limit);
    },
  };

  return { ...queries, transaction: (work) => work(queries) };
}
