import {
  ANALYTICS_TOP_LIMIT,
  HEALTH_NEUTRAL_REASONS,
  type AnalyticsOverview,
  type AnalyticsRange,
  type FailureReasonCount,
  type LatencyStats,
  type MonitorMetrics,
} from '@rain/shared';
import { monitorNotFound } from '../monitors/monitor-service.js';
import type {
  AnalyticsQueries,
  AnalyticsRepository,
  AnalyticsScope,
  CheckTotalsRow,
  MonitorRefRow,
} from './analytics-repository.js';
import {
  buildSeries,
  checkStats,
  ms,
  percent,
  resolveWindow,
  type ResolvedWindow,
} from './analytics-window.js';

export interface AnalyticsService {
  overview(ownerId: string, range: AnalyticsRange): Promise<AnalyticsOverview>;
  monitorMetrics(
    ownerId: string,
    monitorId: string,
    range: AnalyticsRange,
  ): Promise<MonitorMetrics>;
}

export interface AnalyticsServiceDependencies {
  repository: AnalyticsRepository;
  now?: () => Date;
}

function latencyStats(t: CheckTotalsRow): LatencyStats {
  const none = t.latencySamples === 0;
  return {
    samples: t.latencySamples,
    avgMs: none ? null : ms(t.avgMs),
    minMs: none ? null : ms(t.minMs),
    maxMs: none ? null : ms(t.maxMs),
    p50Ms: none ? null : ms(t.p50Ms),
    p95Ms: none ? null : ms(t.p95Ms),
    p99Ms: none ? null : ms(t.p99Ms),
  };
}

function windowOut(w: ResolvedWindow) {
  return {
    range: w.range,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    bucketSeconds: w.bucketSeconds,
  };
}

/** Everything shared by the overview and the per-monitor metrics, for one scope. */
async function scopedMetrics(tx: AnalyticsQueries, scope: AnalyticsScope, w: ResolvedWindow) {
  const range = { from: w.from, to: w.to };
  const [totals, checkBuckets, reasons, incidents, incidentBuckets] = await Promise.all([
    tx.checkTotals(scope, range),
    tx.checkBuckets(scope, range, w.bucketSeconds),
    tx.failureReasons(scope, range),
    tx.incidentTotals(scope, range),
    tx.incidentBuckets(scope, range, w.bucketSeconds),
  ]);
  const failureReasons: FailureReasonCount[] = reasons.map((r) => ({
    reason: r.reason,
    count: r.count,
    excludedFromAvailability: HEALTH_NEUTRAL_REASONS.has(r.reason),
  }));
  return {
    checks: checkStats(totals),
    latency: latencyStats(totals),
    series: buildSeries(w, checkBuckets, incidentBuckets),
    failureReasons,
    incidents: {
      opened: incidents.opened,
      resolved: incidents.resolved,
      currentlyOpen: incidents.currentlyOpen,
      // Only completed resolutions: open incidents never count as a resolution time.
      averageResolutionMs:
        incidents.resolved > 0 && incidents.averageResolutionMs !== null
          ? Math.round(incidents.averageResolutionMs)
          : null,
    },
  };
}

export function createAnalyticsService(deps: AnalyticsServiceDependencies): AnalyticsService {
  const { repository } = deps;
  const now = deps.now ?? (() => new Date());
  // One consistent, read-only snapshot per response.
  const snapshot = <T>(work: (tx: AnalyticsQueries) => Promise<T>) =>
    repository.transaction(work, { isolationLevel: 'repeatable read', accessMode: 'read only' });

  return {
    async overview(ownerId, range) {
      const w = resolveWindow(range, now());
      const timeRange = { from: w.from, to: w.to };
      return snapshot(async (tx) => {
        const [monitors, metrics, topFailing, topIncidents] = await Promise.all([
          tx.monitorCounts(ownerId),
          scopedMetrics(tx, { ownerId }, w),
          tx.topFailingMonitors(ownerId, timeRange, ANALYTICS_TOP_LIMIT),
          tx.topIncidentMonitors(ownerId, timeRange, ANALYTICS_TOP_LIMIT),
        ]);
        const ref = (r: MonitorRefRow) => ({
          id: r.id,
          name: r.name,
          currentStatus: r.currentStatus,
          enabled: r.enabled,
        });
        return {
          window: windowOut(w),
          monitors,
          ...metrics,
          topFailingMonitors: topFailing.map((r) => ({
            monitor: ref(r),
            failed: r.failed,
            eligible: r.eligible,
            availabilityPercent: percent(r.successful, r.eligible),
          })),
          topIncidentMonitors: topIncidents.map((r) => ({
            monitor: ref(r),
            incidents: r.incidents,
          })),
        };
      });
    },

    async monitorMetrics(ownerId, monitorId, range) {
      const w = resolveWindow(range, now());
      return snapshot(async (tx) => {
        // Ownership first: someone else's monitor is indistinguishable from a missing one.
        const monitor = await tx.findMonitor(ownerId, monitorId);
        if (!monitor) throw monitorNotFound();
        return {
          window: windowOut(w),
          monitor,
          ...(await scopedMetrics(tx, { ownerId, monitorId }, w)),
        };
      });
    },
  };
}
