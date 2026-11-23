import type { AnalyticsRange } from '@rain/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MonitorStateBadges } from '@/features/monitors/status-badge';
import {
  AVAILABILITY_HINT,
  FailureCard,
  IncidentStatsCard,
  PerformanceCharts,
  RangeSelector,
  StatCard,
} from './analytics-sections';
import { AnalyticsSkeleton } from './analytics-page';
import { useMonitorMetrics } from './api';
import { formatAvailability, formatCount, formatLatency, formatPercent } from './format';

/** The Analytics tab of a monitor's details page. */
export function MonitorAnalytics({ monitorId }: { monitorId: string }) {
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const query = useMonitorMetrics(monitorId, range);
  const data = query.data;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-muted-foreground">{AVAILABILITY_HINT}</p>
        <RangeSelector value={range} onChange={setRange} />
      </div>
      {query.isPending ? (
        <AnalyticsSkeleton />
      ) : query.isError && !data ? (
        <ErrorState
          title="Couldn't load analytics"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : data ? (
        <div
          className={cn('grid gap-6', query.isPlaceholderData && 'opacity-60')}
          aria-busy={query.isFetching}
        >
          <section
            aria-label="Monitor summary"
            className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5"
          >
            <StatCard
              label="Current health"
              value={
                <MonitorStateBadges
                  status={data.monitor.currentStatus}
                  enabled={data.monitor.enabled}
                />
              }
            />
            <StatCard
              label="Availability"
              value={formatAvailability(data.checks.availabilityPercent)}
              hint="Check-based"
            />
            <StatCard label="Average response" value={formatLatency(data.latency.avgMs)} />
            <StatCard label="P50" value={formatLatency(data.latency.p50Ms)} />
            <StatCard label="P95" value={formatLatency(data.latency.p95Ms)} />
            <StatCard label="P99" value={formatLatency(data.latency.p99Ms)} />
            <StatCard
              label="Total checks"
              value={formatCount(data.checks.recorded)}
              hint={
                data.checks.excluded
                  ? `${formatCount(data.checks.excluded)} refused by RAIN, not counted`
                  : undefined
              }
            />
            <StatCard label="Failed checks" value={formatCount(data.checks.failed)} />
            <StatCard label="Failure rate" value={formatPercent(data.checks.failurePercent)} />
            <StatCard label="Open incidents" value={formatCount(data.incidents.currentlyOpen)} />
          </section>
          {data.checks.recorded === 0 && (
            <p className="text-sm text-muted-foreground">
              No checks were recorded for this monitor in this period
              {data.monitor.enabled ? '.' : ' (it is paused).'}
            </p>
          )}
          <PerformanceCharts series={data.series} range={data.window.range} />
          <div className="grid gap-4 xl:grid-cols-2">
            <FailureCard checks={data.checks} reasons={data.failureReasons} />
            <div className="grid content-start gap-4">
              <IncidentStatsCard incidents={data.incidents} />
              <Button asChild variant="outline" size="sm" className="justify-self-start">
                <Link to={`/app/incidents?monitorId=${monitorId}`}>
                  View this monitor's incidents
                </Link>
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
