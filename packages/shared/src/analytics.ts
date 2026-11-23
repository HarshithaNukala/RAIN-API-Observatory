import { z } from 'zod';
import { CHECK_FAILURE_REASONS, HEALTH_NEUTRAL_REASONS } from './monitor-check.js';
import { MonitorStatusSchema } from './monitor.js';

/**
 * Metrics and analytics contracts. Every figure is computed by PostgreSQL from persisted
 * `monitor_checks` and `incidents` rows; nothing is estimated or filled in.
 *
 * Definitions (see docs/metrics-and-analytics.md):
 * - **Eligible check**: a recorded check whose failure reason is not health-neutral. Checks RAIN
 *   refused to send (`BLOCKED_DESTINATION`, `CONFIGURATION_ERROR`) are excluded: they say nothing
 *   about the monitored API.
 * - **Available**: an eligible check that got the expected status (SUCCESS, or DEGRADED when it was
 *   slower than the latency threshold).
 * - **Check-based availability** = available / eligible × 100, or `null` ("No data") when there
 *   are no eligible checks. Paused and unmonitored time is not observed, so it isn't counted.
 * - **Latency** statistics use only checks that received HTTP response headers (latency is NULL
 *   otherwise, never zero), including unexpected statuses.
 */

export const ANALYTICS_RANGES = ['24h', '7d', '30d'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const AnalyticsRangeSchema = z.enum(ANALYTICS_RANGES);

/**
 * Each range is a fixed number of UTC-aligned buckets ending with the bucket that contains "now"
 * (so the newest bucket is partial). 24h: 24 hourly buckets; 7d: 28 six-hour buckets; 30d: 30
 * daily buckets.
 */
export const ANALYTICS_RANGE_CONFIG: Record<
  AnalyticsRange,
  { bucketSeconds: number; buckets: number; label: string }
> = {
  '24h': { bucketSeconds: 3600, buckets: 24, label: 'Last 24 hours' },
  '7d': { bucketSeconds: 6 * 3600, buckets: 28, label: 'Last 7 days' },
  '30d': { bucketSeconds: 86_400, buckets: 30, label: 'Last 30 days' },
};

/** Failure reasons that never count toward availability (RAIN's own refusals). */
export const EXCLUDED_FROM_AVAILABILITY: readonly string[] = [...HEALTH_NEUTRAL_REASONS];

export const AnalyticsQuerySchema = z.object({
  range: AnalyticsRangeSchema.default('24h'),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

const timestamp = z.iso.datetime({ offset: true });
const nullableNumber = z.number().nullable();

export const AnalyticsWindowSchema = z.object({
  range: AnalyticsRangeSchema,
  /** Inclusive start (UTC, aligned to a bucket boundary). */
  from: timestamp,
  /** Inclusive end: the time the metrics were computed. */
  to: timestamp,
  bucketSeconds: z.number().int(),
});
export type AnalyticsWindow = z.infer<typeof AnalyticsWindowSchema>;

export const CheckStatsSchema = z.object({
  /** All checks recorded in the window, eligible or not. */
  recorded: z.number().int(),
  /** Checks that count toward availability. */
  eligible: z.number().int(),
  /** Eligible checks with the expected status (fast or slow). */
  successful: z.number().int(),
  /** Eligible checks that failed. */
  failed: z.number().int(),
  /** Expected status but slower than the latency threshold (a subset of `successful`). */
  slow: z.number().int(),
  /** RAIN refusals left out of availability. */
  excluded: z.number().int(),
  /** successful / eligible × 100; null when nothing eligible was recorded. */
  availabilityPercent: nullableNumber,
  /** failed / eligible × 100; null when nothing eligible was recorded. */
  failurePercent: nullableNumber,
});
export type CheckStats = z.infer<typeof CheckStatsSchema>;

/** All values in milliseconds; null when no check in the window received a response. */
export const LatencyStatsSchema = z.object({
  /** Checks with a measured latency. */
  samples: z.number().int(),
  avgMs: nullableNumber,
  minMs: nullableNumber,
  maxMs: nullableNumber,
  p50Ms: nullableNumber,
  p95Ms: nullableNumber,
  p99Ms: nullableNumber,
});
export type LatencyStats = z.infer<typeof LatencyStatsSchema>;

/** One time bucket. Buckets with no checks have zero counts and null rates/latencies. */
export const AnalyticsBucketSchema = z.object({
  start: timestamp,
  end: timestamp,
  eligible: z.number().int(),
  successful: z.number().int(),
  failed: z.number().int(),
  slow: z.number().int(),
  excluded: z.number().int(),
  availabilityPercent: nullableNumber,
  avgLatencyMs: nullableNumber,
  /** P95 of the checks in this bucket (computed per bucket, never averaged). */
  p95LatencyMs: nullableNumber,
  incidentsOpened: z.number().int(),
  incidentsResolved: z.number().int(),
});
export type AnalyticsBucket = z.infer<typeof AnalyticsBucketSchema>;

export const FailureReasonCountSchema = z.object({
  reason: z.enum(CHECK_FAILURE_REASONS),
  count: z.number().int(),
  /** True for RAIN refusals, which are excluded from availability. */
  excludedFromAvailability: z.boolean(),
});
export type FailureReasonCount = z.infer<typeof FailureReasonCountSchema>;

export const IncidentStatsSchema = z.object({
  /** Incidents whose `started_at` is in the window. */
  opened: z.number().int(),
  /** Incidents whose `resolved_at` is in the window. */
  resolved: z.number().int(),
  /** Incidents open or acknowledged right now (not limited to the window). */
  currentlyOpen: z.number().int(),
  /** Mean started_at → resolved_at of the incidents resolved in the window; null if none. */
  averageResolutionMs: nullableNumber,
});
export type IncidentStats = z.infer<typeof IncidentStatsSchema>;

export const AnalyticsMonitorRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  currentStatus: MonitorStatusSchema,
  enabled: z.boolean(),
});

export const TopFailingMonitorSchema = z.object({
  monitor: AnalyticsMonitorRefSchema,
  failed: z.number().int(),
  eligible: z.number().int(),
  availabilityPercent: nullableNumber,
});

export const TopIncidentMonitorSchema = z.object({
  monitor: AnalyticsMonitorRefSchema,
  incidents: z.number().int(),
});

/** At most this many monitors in each "top" list. */
export const ANALYTICS_TOP_LIMIT = 5;

export const AnalyticsOverviewSchema = z.object({
  window: AnalyticsWindowSchema,
  /** Current state, not limited to the window. Paused monitors are counted separately. */
  monitors: z.object({
    total: z.number().int(),
    healthy: z.number().int(),
    degraded: z.number().int(),
    down: z.number().int(),
    unknown: z.number().int(),
    paused: z.number().int(),
  }),
  checks: CheckStatsSchema,
  latency: LatencyStatsSchema,
  series: z.array(AnalyticsBucketSchema),
  failureReasons: z.array(FailureReasonCountSchema),
  incidents: IncidentStatsSchema,
  topFailingMonitors: z.array(TopFailingMonitorSchema),
  topIncidentMonitors: z.array(TopIncidentMonitorSchema),
});
export type AnalyticsOverview = z.infer<typeof AnalyticsOverviewSchema>;

export const MonitorMetricsSchema = z.object({
  window: AnalyticsWindowSchema,
  monitor: AnalyticsMonitorRefSchema,
  checks: CheckStatsSchema,
  latency: LatencyStatsSchema,
  series: z.array(AnalyticsBucketSchema),
  failureReasons: z.array(FailureReasonCountSchema),
  incidents: IncidentStatsSchema,
});
export type MonitorMetrics = z.infer<typeof MonitorMetricsSchema>;
