/**
 * TEST ONLY. Builders for analytics API responses, shaped exactly like the server's contracts.
 * Defaults describe "nothing recorded" (zero counts, null rates and latencies), never made-up
 * performance; tests override what they assert on.
 */
import {
  ANALYTICS_RANGE_CONFIG,
  AnalyticsOverviewSchema,
  MonitorMetricsSchema,
  type AnalyticsBucket,
  type AnalyticsOverview,
  type AnalyticsRange,
  type MonitorMetrics,
} from '@rain/shared';

export const FIXTURE_NOW = '2026-11-19T10:30:00.000Z';

export function emptySeries(range: AnalyticsRange, nowIso = FIXTURE_NOW): AnalyticsBucket[] {
  const { bucketSeconds, buckets } = ANALYTICS_RANGE_CONFIG[range];
  const size = bucketSeconds * 1000;
  const now = Date.parse(nowIso);
  const first = Math.floor(now / size) * size - (buckets - 1) * size;
  return Array.from({ length: buckets }, (_, i) => ({
    start: new Date(first + i * size).toISOString(),
    end: new Date(Math.min(first + (i + 1) * size, now)).toISOString(),
    eligible: 0,
    successful: 0,
    failed: 0,
    slow: 0,
    excluded: 0,
    availabilityPercent: null,
    avgLatencyMs: null,
    p95LatencyMs: null,
    incidentsOpened: 0,
    incidentsResolved: 0,
  }));
}

/** Fills the last buckets of a series with the given values (oldest of them first). */
export function withRecentBuckets(
  series: AnalyticsBucket[],
  recent: Array<Partial<AnalyticsBucket>>,
): AnalyticsBucket[] {
  const offset = series.length - recent.length;
  return series.map((b, i) => (i >= offset ? { ...b, ...recent[i - offset] } : b));
}

const windowFor = (range: AnalyticsRange) => {
  const series = emptySeries(range);
  return {
    range,
    from: series[0]!.start,
    to: FIXTURE_NOW,
    bucketSeconds: ANALYTICS_RANGE_CONFIG[range].bucketSeconds,
  };
};

const emptyChecks = {
  recorded: 0,
  eligible: 0,
  successful: 0,
  failed: 0,
  slow: 0,
  excluded: 0,
  availabilityPercent: null,
  failurePercent: null,
};
const emptyLatency = {
  samples: 0,
  avgMs: null,
  minMs: null,
  maxMs: null,
  p50Ms: null,
  p95Ms: null,
  p99Ms: null,
};
const emptyIncidents = { opened: 0, resolved: 0, currentlyOpen: 0, averageResolutionMs: null };

export function makeOverview(
  range: AnalyticsRange,
  overrides: Partial<AnalyticsOverview> = {},
): AnalyticsOverview {
  return AnalyticsOverviewSchema.parse({
    window: windowFor(range),
    monitors: { total: 0, healthy: 0, degraded: 0, down: 0, unknown: 0, paused: 0 },
    checks: emptyChecks,
    latency: emptyLatency,
    series: emptySeries(range),
    failureReasons: [],
    incidents: emptyIncidents,
    topFailingMonitors: [],
    topIncidentMonitors: [],
    ...overrides,
  });
}

export function makeMonitorMetrics(
  range: AnalyticsRange,
  monitor: MonitorMetrics['monitor'],
  overrides: Partial<MonitorMetrics> = {},
): MonitorMetrics {
  return MonitorMetricsSchema.parse({
    window: windowFor(range),
    monitor,
    checks: emptyChecks,
    latency: emptyLatency,
    series: emptySeries(range),
    failureReasons: [],
    incidents: emptyIncidents,
    ...overrides,
  });
}
