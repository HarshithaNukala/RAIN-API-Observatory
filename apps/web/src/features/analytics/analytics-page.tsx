import type { AnalyticsOverview } from '@rain/shared';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Gauge,
  ListX,
  Plus,
  Siren,
  XCircle,
} from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MonitorStateBadges } from '@/features/monitors/status-badge';
import {
  AVAILABILITY_HINT,
  FailureCard,
  IncidentStatsCard,
  LatencyCard,
  PerformanceCharts,
  RangeSelector,
  StatCard,
} from './analytics-sections';
import { useAnalyticsOverview } from './api';
import { formatAvailability, formatCount } from './format';
import { useRangeParam } from './use-range-param';

export function AnalyticsSkeleton() {
  return (
    <div className="grid gap-4" aria-busy>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

function TopMonitors({ data }: { data: AnalyticsOverview }) {
  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">Most failed checks</CardTitle>
          <CardDescription>Monitors with the most failed checks in this period.</CardDescription>
        </CardHeader>
        {data.topFailingMonitors.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">No failed checks in this period.</p>
          </CardContent>
        ) : (
          <Table aria-label="Monitors with the most failures">
            <thead className="bg-muted/30">
              <tr>
                <Th>Monitor</Th>
                <Th className="text-right">Failed</Th>
                <Th className="hidden text-right sm:table-cell">Availability</Th>
              </tr>
            </thead>
            <tbody>
              {data.topFailingMonitors.map((t) => (
                <tr key={t.monitor.id} className="border-t border-border">
                  <Td>
                    <Link
                      to={`/app/monitors/${t.monitor.id}`}
                      className="font-medium hover:text-primary"
                    >
                      {t.monitor.name}
                    </Link>
                    <span className="mt-1 block">
                      <MonitorStateBadges
                        status={t.monitor.currentStatus}
                        enabled={t.monitor.enabled}
                      />
                    </span>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {formatCount(t.failed)} / {formatCount(t.eligible)}
                  </Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">
                    {formatAvailability(t.availabilityPercent)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">Most incidents</CardTitle>
          <CardDescription>Monitors with the most incidents opened in this period.</CardDescription>
        </CardHeader>
        {data.topIncidentMonitors.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">No incidents opened in this period.</p>
          </CardContent>
        ) : (
          <Table aria-label="Monitors with the most incidents">
            <thead className="bg-muted/30">
              <tr>
                <Th>Monitor</Th>
                <Th className="text-right">Incidents</Th>
              </tr>
            </thead>
            <tbody>
              {data.topIncidentMonitors.map((t) => (
                <tr key={t.monitor.id} className="border-t border-border">
                  <Td>
                    <Link
                      to={`/app/incidents?monitorId=${t.monitor.id}`}
                      className="font-medium hover:text-primary"
                    >
                      {t.monitor.name}
                    </Link>
                  </Td>
                  <Td className="text-right tabular-nums">{formatCount(t.incidents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

export function AnalyticsPage() {
  const [range, setRange] = useRangeParam();
  const query = useAnalyticsOverview(range);
  const data = query.data;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Analytics"
        description="Availability, response times, failures and incidents across your monitors, from recorded checks."
        actions={<RangeSelector value={range} onChange={setRange} />}
      />

      {query.isPending ? (
        <AnalyticsSkeleton />
      ) : query.isError && !data ? (
        <ErrorState
          title="Couldn't load analytics"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : data && data.monitors.total === 0 ? (
        <Card>
          <EmptyState
            icon={BarChart3}
            title="No monitors yet"
            action={
              <Button asChild>
                <Link to="/app/monitors/new">
                  <Plus aria-hidden /> Add a monitor
                </Link>
              </Button>
            }
          >
            Analytics appear once your monitors have recorded checks.
          </EmptyState>
        </Card>
      ) : data ? (
        <div
          className={cn('grid gap-6', query.isPlaceholderData && 'opacity-60')}
          aria-busy={query.isFetching}
        >
          <section
            aria-label="Summary"
            className="stagger grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4"
          >
            <StatCard
              className="col-span-2"
              tone="primary"
              icon={Activity}
              label="Monitors"
              value={formatCount(data.monitors.total)}
              hint={`${data.monitors.paused} paused · ${data.monitors.unknown} not checked yet`}
            />
            <StatCard
              label="Healthy"
              tone="healthy"
              icon={CheckCircle2}
              value={formatCount(data.monitors.healthy)}
            />
            <StatCard
              label="Degraded"
              tone="degraded"
              icon={AlertTriangle}
              value={formatCount(data.monitors.degraded)}
            />
            <StatCard
              label="Down"
              tone="down"
              icon={XCircle}
              value={formatCount(data.monitors.down)}
            />
            <StatCard
              tone="healthy"
              icon={Gauge}
              label="Availability"
              trend={data.series.map((b) => b.availabilityPercent)}
              value={formatAvailability(data.checks.availabilityPercent)}
              hint="Check-based"
            />
            <StatCard
              tone={data.checks.failed > 0 ? 'degraded' : 'healthy'}
              icon={ListX}
              trend={data.series.map((b) => b.failed)}
              label="Failed checks"
              value={formatCount(data.checks.failed)}
              hint={`of ${formatCount(data.checks.eligible)} counted`}
            />
            <StatCard
              tone={data.incidents.currentlyOpen > 0 ? 'down' : 'healthy'}
              icon={Siren}
              trend={data.series.map((b) => b.incidentsOpened)}
              label="Active incidents"
              value={formatCount(data.incidents.currentlyOpen)}
              hint={
                <Link to="/app/incidents?status=ACTIVE" className="hover:text-primary">
                  View incidents
                </Link>
              }
            />
          </section>
          <p className="-mt-2 text-xs text-muted-foreground">{AVAILABILITY_HINT}</p>

          <PerformanceCharts series={data.series} range={data.window.range} />

          <div className="stagger grid gap-4 xl:grid-cols-2">
            <LatencyCard latency={data.latency} />
            <FailureCard checks={data.checks} reasons={data.failureReasons} />
          </div>

          <div className="stagger grid gap-4 xl:grid-cols-3">
            <IncidentStatsCard incidents={data.incidents} />
            <TopMonitors data={data} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
