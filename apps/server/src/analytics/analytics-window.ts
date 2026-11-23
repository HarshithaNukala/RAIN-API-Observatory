import {
  ANALYTICS_RANGE_CONFIG,
  type AnalyticsBucket,
  type AnalyticsRange,
  type CheckStats,
} from '@rain/shared';

/**
 * Pure time-window and assembly rules for analytics. The heavy lifting (counts, averages,
 * percentiles) happens in PostgreSQL; this module decides the window, lays out the buckets and
 * turns aggregate counts into rates, without ever inventing a value for an empty bucket.
 */

export interface ResolvedWindow {
  range: AnalyticsRange;
  from: Date;
  to: Date;
  bucketSeconds: number;
  /** Bucket start times, oldest first, UTC-aligned. */
  bucketStarts: Date[];
}

/**
 * A range is N whole UTC-aligned buckets ending with the bucket that contains `now`:
 * from = floor(now / size) × size − (N − 1) × size, to = now. The last bucket is therefore partial,
 * and the window covers between N − 1 and N bucket lengths. PostgreSQL's `date_bin` with the Unix
 * epoch as origin produces exactly these boundaries.
 */
export function resolveWindow(range: AnalyticsRange, now: Date): ResolvedWindow {
  const { bucketSeconds, buckets } = ANALYTICS_RANGE_CONFIG[range];
  const size = bucketSeconds * 1000;
  const current = Math.floor(now.getTime() / size) * size;
  const first = current - (buckets - 1) * size;
  return {
    range,
    from: new Date(first),
    to: now,
    bucketSeconds,
    bucketStarts: Array.from({ length: buckets }, (_, i) => new Date(first + i * size)),
  };
}

/** a / b × 100 with three decimals, or null when there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100_000) / 1000;
}

/** One decimal millisecond, or null. Never turns a missing value into 0. */
export function ms(value: number | null | undefined): number | null {
  return value === null || value === undefined || Number.isNaN(value)
    ? null
    : Math.round(value * 10) / 10;
}

export interface CheckCounts {
  recorded: number;
  eligible: number;
  successful: number;
  failed: number;
  slow: number;
  excluded: number;
}

export function checkStats(counts: CheckCounts): CheckStats {
  // Picked explicitly: callers pass wider rows (with latency columns) that must not leak through.
  return {
    recorded: counts.recorded,
    eligible: counts.eligible,
    successful: counts.successful,
    failed: counts.failed,
    slow: counts.slow,
    excluded: counts.excluded,
    availabilityPercent: percent(counts.successful, counts.eligible),
    failurePercent: percent(counts.failed, counts.eligible),
  };
}

export interface CheckBucketRow {
  bucketMs: number;
  eligible: number;
  successful: number;
  failed: number;
  slow: number;
  excluded: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface IncidentBucketRow {
  bucketMs: number;
  opened: number;
  resolved: number;
}

/**
 * Lays the aggregated rows onto the full bucket list. A bucket with no checks keeps zero counts
 * (that is a fact: nothing was recorded) but null availability and latency (no measurement).
 */
export function buildSeries(
  window: ResolvedWindow,
  checks: CheckBucketRow[],
  incidents: IncidentBucketRow[],
): AnalyticsBucket[] {
  const size = window.bucketSeconds * 1000;
  const checkBy = new Map(checks.map((r) => [r.bucketMs, r]));
  const incidentBy = new Map(incidents.map((r) => [r.bucketMs, r]));
  return window.bucketStarts.map((start) => {
    const c = checkBy.get(start.getTime());
    const i = incidentBy.get(start.getTime());
    const end = new Date(Math.min(start.getTime() + size, window.to.getTime()));
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      eligible: c?.eligible ?? 0,
      successful: c?.successful ?? 0,
      failed: c?.failed ?? 0,
      slow: c?.slow ?? 0,
      excluded: c?.excluded ?? 0,
      availabilityPercent: c ? percent(c.successful, c.eligible) : null,
      avgLatencyMs: ms(c?.avgLatencyMs),
      p95LatencyMs: ms(c?.p95LatencyMs),
      incidentsOpened: i?.opened ?? 0,
      incidentsResolved: i?.resolved ?? 0,
    };
  });
}
