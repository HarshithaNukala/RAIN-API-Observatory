import { HEALTH_NEUTRAL_REASONS, type CheckFailureReason, type MonitorStatus } from '@rain/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import type { CheckBucketRow, CheckCounts, IncidentBucketRow } from './analytics-window.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

/** The analytics scope: always an owner, optionally one of their monitors. */
export interface AnalyticsScope {
  ownerId: string;
  monitorId?: string | undefined;
}

export interface TimeRange {
  from: Date;
  to: Date;
}

export interface CheckTotalsRow extends CheckCounts {
  latencySamples: number;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface MonitorRefRow {
  id: string;
  name: string;
  currentStatus: MonitorStatus;
  enabled: boolean;
}

export interface MonitorCountsRow {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  unknown: number;
  paused: number;
}

export interface IncidentTotalsRow {
  opened: number;
  resolved: number;
  currentlyOpen: number;
  averageResolutionMs: number | null;
}

export interface TopFailingRow extends MonitorRefRow {
  failed: number;
  eligible: number;
  successful: number;
}

export interface TopIncidentRow extends MonitorRefRow {
  incidents: number;
}

// Built from the shared constant (no user input), so it can be inlined safely.
const NEUTRAL = sql.raw([...HEALTH_NEUTRAL_REASONS].map((r) => `'${r}'`).join(', '));
/** A check counts toward availability unless RAIN itself refused to send it. */
const ELIGIBLE = sql`(c.failure_reason IS NULL OR c.failure_reason NOT IN (${NEUTRAL}))`;

const iso = (d: Date) => d.toISOString();
/** UTC bucket boundaries aligned to the Unix epoch (same as resolveWindow). */
const bucketOf = (column: SQL, bucketSeconds: number) =>
  sql`(extract(epoch from date_bin(make_interval(secs => ${bucketSeconds}), ${column}, timestamptz '1970-01-01 00:00:00+00')) * 1000)::float8`;

const ownedMonitors = (scope: AnalyticsScope) =>
  scope.monitorId
    ? sql`m.owner_id = ${scope.ownerId} AND m.id = ${scope.monitorId}`
    : sql`m.owner_id = ${scope.ownerId}`;
const ownedIncidents = (scope: AnalyticsScope) =>
  scope.monitorId
    ? sql`i.owner_id = ${scope.ownerId} AND i.monitor_id = ${scope.monitorId}`
    : sql`i.owner_id = ${scope.ownerId}`;

/** Checks of the owner's monitors in the window: an index range scan per monitor. */
const checksIn = (scope: AnalyticsScope, range: TimeRange) => sql`
  FROM monitor_checks c
  JOIN monitors m ON m.id = c.monitor_id
  WHERE ${ownedMonitors(scope)}
    AND c.checked_at >= ${iso(range.from)}::timestamptz
    AND c.checked_at <= ${iso(range.to)}::timestamptz`;

const COUNTS = sql`
  count(*)::int AS "recorded",
  count(*) FILTER (WHERE ${ELIGIBLE})::int AS "eligible",
  count(*) FILTER (WHERE ${ELIGIBLE} AND c.outcome <> 'FAILURE')::int AS "successful",
  count(*) FILTER (WHERE ${ELIGIBLE} AND c.outcome = 'FAILURE')::int AS "failed",
  count(*) FILTER (WHERE c.outcome = 'DEGRADED')::int AS "slow",
  count(*) FILTER (WHERE NOT ${ELIGIBLE})::int AS "excluded"`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Every statement here is scoped by owner in SQL; there is no way to aggregate another user's
 * data through this module. Percentiles use PostgreSQL's exact ordered-set aggregate
 * `percentile_cont` (linear interpolation; NULL latencies are ignored by the aggregate itself).
 */
function queries(db: Executor) {
  const rows = async <T>(query: SQL): Promise<T[]> => (await db.execute(query)) as unknown as T[];

  return {
    async findMonitor(ownerId: string, monitorId: string): Promise<MonitorRefRow | undefined> {
      const [row] = await rows<MonitorRefRow>(sql`
        SELECT m.id, m.name, m.current_status AS "currentStatus", m.enabled
        FROM monitors m WHERE m.owner_id = ${ownerId} AND m.id = ${monitorId}`);
      return row;
    },

    async monitorCounts(ownerId: string): Promise<MonitorCountsRow> {
      const [row] = await rows<MonitorCountsRow>(sql`
        SELECT
          count(*)::int AS "total",
          count(*) FILTER (WHERE m.enabled AND m.current_status = 'HEALTHY')::int AS "healthy",
          count(*) FILTER (WHERE m.enabled AND m.current_status = 'DEGRADED')::int AS "degraded",
          count(*) FILTER (WHERE m.enabled AND m.current_status = 'DOWN')::int AS "down",
          count(*) FILTER (WHERE m.enabled AND m.current_status = 'UNKNOWN')::int AS "unknown",
          count(*) FILTER (WHERE NOT m.enabled)::int AS "paused"
        FROM monitors m WHERE m.owner_id = ${ownerId}`);
      return row!;
    },

    async checkTotals(scope: AnalyticsScope, range: TimeRange): Promise<CheckTotalsRow> {
      const [row] = await rows<Record<string, unknown>>(sql`
        SELECT ${COUNTS},
          count(c.latency_ms)::int AS "latencySamples",
          avg(c.latency_ms)::float8 AS "avgMs",
          min(c.latency_ms)::float8 AS "minMs",
          max(c.latency_ms)::float8 AS "maxMs",
          percentile_cont(0.5) WITHIN GROUP (ORDER BY c.latency_ms)::float8 AS "p50Ms",
          percentile_cont(0.95) WITHIN GROUP (ORDER BY c.latency_ms)::float8 AS "p95Ms",
          percentile_cont(0.99) WITHIN GROUP (ORDER BY c.latency_ms)::float8 AS "p99Ms"
        ${checksIn(scope, range)}`);
      const r = row ?? {};
      return {
        recorded: Number(r.recorded ?? 0),
        eligible: Number(r.eligible ?? 0),
        successful: Number(r.successful ?? 0),
        failed: Number(r.failed ?? 0),
        slow: Number(r.slow ?? 0),
        excluded: Number(r.excluded ?? 0),
        latencySamples: Number(r.latencySamples ?? 0),
        avgMs: num(r.avgMs),
        minMs: num(r.minMs),
        maxMs: num(r.maxMs),
        p50Ms: num(r.p50Ms),
        p95Ms: num(r.p95Ms),
        p99Ms: num(r.p99Ms),
      };
    },

    async checkBuckets(
      scope: AnalyticsScope,
      range: TimeRange,
      bucketSeconds: number,
    ): Promise<CheckBucketRow[]> {
      const result = await rows<Record<string, unknown>>(sql`
        SELECT ${bucketOf(sql`c.checked_at`, bucketSeconds)} AS "bucketMs",
          ${COUNTS},
          avg(c.latency_ms)::float8 AS "avgLatencyMs",
          percentile_cont(0.95) WITHIN GROUP (ORDER BY c.latency_ms)::float8 AS "p95LatencyMs"
        ${checksIn(scope, range)}
        GROUP BY 1 ORDER BY 1`);
      return result.map((r) => ({
        bucketMs: Number(r.bucketMs),
        eligible: Number(r.eligible),
        successful: Number(r.successful),
        failed: Number(r.failed),
        slow: Number(r.slow),
        excluded: Number(r.excluded),
        avgLatencyMs: num(r.avgLatencyMs),
        p95LatencyMs: num(r.p95LatencyMs),
      }));
    },

    async failureReasons(
      scope: AnalyticsScope,
      range: TimeRange,
    ): Promise<Array<{ reason: CheckFailureReason; count: number }>> {
      const result = await rows<{ reason: CheckFailureReason; count: number }>(sql`
        SELECT c.failure_reason AS "reason", count(*)::int AS "count"
        ${checksIn(scope, range)} AND c.failure_reason IS NOT NULL
        GROUP BY c.failure_reason
        ORDER BY count(*) DESC, c.failure_reason ASC`);
      return result.map((r) => ({ reason: r.reason, count: Number(r.count) }));
    },

    async incidentTotals(scope: AnalyticsScope, range: TimeRange): Promise<IncidentTotalsRow> {
      const from = iso(range.from);
      const to = iso(range.to);
      const [row] = await rows<Record<string, unknown>>(sql`
        SELECT
          count(*) FILTER (WHERE i.started_at >= ${from}::timestamptz AND i.started_at <= ${to}::timestamptz)::int AS "opened",
          count(*) FILTER (WHERE i.resolved_at >= ${from}::timestamptz AND i.resolved_at <= ${to}::timestamptz)::int AS "resolved",
          count(*) FILTER (WHERE i.status <> 'RESOLVED')::int AS "currentlyOpen",
          (avg(extract(epoch from (i.resolved_at - i.started_at)) * 1000)
            FILTER (WHERE i.resolved_at >= ${from}::timestamptz AND i.resolved_at <= ${to}::timestamptz))::float8
            AS "averageResolutionMs"
        FROM incidents i WHERE ${ownedIncidents(scope)}`);
      const r = row ?? {};
      return {
        opened: Number(r.opened ?? 0),
        resolved: Number(r.resolved ?? 0),
        currentlyOpen: Number(r.currentlyOpen ?? 0),
        averageResolutionMs: num(r.averageResolutionMs),
      };
    },

    async incidentBuckets(
      scope: AnalyticsScope,
      range: TimeRange,
      bucketSeconds: number,
    ): Promise<IncidentBucketRow[]> {
      const from = iso(range.from);
      const to = iso(range.to);
      const result = await rows<Record<string, unknown>>(sql`
        WITH events AS (
          SELECT ${bucketOf(sql`i.started_at`, bucketSeconds)} AS bucket, 1 AS opened, 0 AS resolved
          FROM incidents i
          WHERE ${ownedIncidents(scope)} AND i.started_at >= ${from}::timestamptz AND i.started_at <= ${to}::timestamptz
          UNION ALL
          SELECT ${bucketOf(sql`i.resolved_at`, bucketSeconds)}, 0, 1
          FROM incidents i
          WHERE ${ownedIncidents(scope)} AND i.resolved_at >= ${from}::timestamptz AND i.resolved_at <= ${to}::timestamptz
        )
        SELECT bucket AS "bucketMs", sum(opened)::int AS "opened", sum(resolved)::int AS "resolved"
        FROM events GROUP BY bucket ORDER BY bucket`);
      return result.map((r) => ({
        bucketMs: Number(r.bucketMs),
        opened: Number(r.opened),
        resolved: Number(r.resolved),
      }));
    },

    async topFailingMonitors(
      ownerId: string,
      range: TimeRange,
      limit: number,
    ): Promise<TopFailingRow[]> {
      const result = await rows<Record<string, unknown>>(sql`
        SELECT m.id, m.name, m.current_status AS "currentStatus", m.enabled,
          count(*) FILTER (WHERE ${ELIGIBLE} AND c.outcome = 'FAILURE')::int AS "failed",
          count(*) FILTER (WHERE ${ELIGIBLE})::int AS "eligible",
          count(*) FILTER (WHERE ${ELIGIBLE} AND c.outcome <> 'FAILURE')::int AS "successful"
        ${checksIn({ ownerId }, range)}
        GROUP BY m.id
        HAVING count(*) FILTER (WHERE ${ELIGIBLE} AND c.outcome = 'FAILURE') > 0
        ORDER BY 5 DESC, m.name ASC, m.id ASC
        LIMIT ${limit}`);
      return result.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        currentStatus: r.currentStatus as MonitorStatus,
        enabled: Boolean(r.enabled),
        failed: Number(r.failed),
        eligible: Number(r.eligible),
        successful: Number(r.successful),
      }));
    },

    async topIncidentMonitors(
      ownerId: string,
      range: TimeRange,
      limit: number,
    ): Promise<TopIncidentRow[]> {
      const result = await rows<Record<string, unknown>>(sql`
        SELECT m.id, m.name, m.current_status AS "currentStatus", m.enabled,
          count(*)::int AS "incidents"
        FROM incidents i JOIN monitors m ON m.id = i.monitor_id
        WHERE i.owner_id = ${ownerId} AND m.owner_id = ${ownerId}
          AND i.started_at >= ${iso(range.from)}::timestamptz
          AND i.started_at <= ${iso(range.to)}::timestamptz
        GROUP BY m.id
        ORDER BY 5 DESC, m.name ASC, m.id ASC
        LIMIT ${limit}`);
      return result.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        currentStatus: r.currentStatus as MonitorStatus,
        enabled: Boolean(r.enabled),
        incidents: Number(r.incidents),
      }));
    },
  };
}

export type AnalyticsQueries = ReturnType<typeof queries>;

export interface AnalyticsRepository extends AnalyticsQueries {
  transaction<T>(
    work: (tx: AnalyticsQueries) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T>;
}

export function createAnalyticsRepository(db: Database): AnalyticsRepository {
  return {
    ...queries(db),
    transaction: (work, config) => db.transaction((tx) => work(queries(tx)), config),
  };
}
