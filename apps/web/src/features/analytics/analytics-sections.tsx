import {
  ANALYTICS_RANGE_CONFIG,
  ANALYTICS_RANGES,
  type AnalyticsBucket,
  type AnalyticsRange,
  type CheckStats,
  type FailureReasonCount,
  type IncidentStats,
  type LatencyStats,
} from '@rain/shared';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CountUp } from '@/components/count-up';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/misc';
import { cn } from '@/lib/utils';
import { FAILURE_REASON_LABELS } from '@/features/monitors/format';
import { formatCount, formatDurationMs, formatLatency, formatPercent } from './format';
import { SERIES_COLORS } from './chart-colors';
import { Sparkline } from './sparkline';
import { TimeSeriesChart } from './time-series-chart';

export function RangeSelector({
  value,
  onChange,
  disabled,
}: {
  value: AnalyticsRange;
  onChange: (range: AnalyticsRange) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Time range"
      className="inline-flex rounded-xl border border-border bg-muted/70 p-1"
    >
      {ANALYTICS_RANGES.map((range) => (
        <Button
          key={range}
          size="sm"
          variant="ghost"
          className={cn(
            'hover:translate-y-0',
            range === value &&
              'bg-card text-primary shadow-[0_2px_8px_-4px_oklch(0.45_0.1_40/0.4)] hover:bg-card',
          )}
          aria-pressed={range === value}
          disabled={disabled}
          onClick={() => onChange(range)}
        >
          {ANALYTICS_RANGE_CONFIG[range].label}
        </Button>
      ))}
    </div>
  );
}

/** Accent colour of a stat card: a health status, the brand colour, or none. */
export type StatTone = 'healthy' | 'degraded' | 'down' | 'unknown' | 'primary';

const TONE_STYLE: Record<StatTone, { card: string; icon: string; spark: string }> = {
  healthy: {
    card: 'border-status-healthy/25 bg-linear-to-br from-card from-45% to-status-healthy/10',
    icon: 'bg-status-healthy/15 text-status-healthy-fg',
    spark: 'var(--color-status-healthy)',
  },
  degraded: {
    card: 'border-status-degraded/35 bg-linear-to-br from-card from-45% to-status-degraded/14',
    icon: 'bg-status-degraded/20 text-status-degraded-fg',
    spark: 'var(--color-status-degraded)',
  },
  down: {
    card: 'border-status-down/25 bg-linear-to-br from-card from-45% to-status-down/10',
    icon: 'bg-status-down/12 text-status-down-fg',
    spark: 'var(--color-status-down)',
  },
  unknown: {
    card: 'bg-linear-to-br from-card from-45% to-muted',
    icon: 'bg-muted text-muted-foreground',
    spark: 'var(--color-status-unknown-fg)',
  },
  primary: {
    card: 'border-primary/20 bg-linear-to-br from-card from-45% to-peach/70',
    icon: 'bg-peach text-primary',
    spark: 'var(--color-primary)',
  },
};

export function StatCard({
  label,
  value,
  hint,
  tone,
  icon: Icon,
  trend,
  className,
}: {
  className?: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  icon?: LucideIcon;
  /** Optional per-bucket values for a small decorative trend line. */
  trend?: Array<number | null>;
}) {
  const style = tone ? TONE_STYLE[tone] : undefined;
  return (
    <Card className={cn('card-lift group relative overflow-hidden', style?.card, className)}>
      {trend && (
        <Sparkline
          values={trend}
          color={style?.spark ?? 'var(--color-primary)'}
          className="absolute right-0 bottom-0 h-[55%] w-[62%] opacity-90"
        />
      )}
      <CardHeader className="relative gap-2 p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          {Icon && (
            <span
              aria-hidden
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full transition-transform duration-300 ease-(--ease-out-soft) group-hover:scale-110 group-hover:rotate-[-6deg]',
                style?.icon ?? 'bg-muted text-muted-foreground',
              )}
            >
              <Icon className="size-[18px]" />
            </span>
          )}
          <CardDescription className="text-[11px] leading-tight font-bold tracking-[0.08em] text-foreground/75 uppercase">
            {label}
          </CardDescription>
        </div>
        <CardTitle
          className="mt-1 text-2xl font-bold tracking-tight whitespace-nowrap tabular-nums sm:text-3xl xl:text-[2rem]"
          // Text values get "Label: value" read as one; rich values (badges) speak for themselves.
          aria-label={
            typeof value === 'string' || typeof value === 'number'
              ? `${label}: ${value}`
              : undefined
          }
        >
          {typeof value === 'string' ? <CountUp value={value} /> : value}
        </CardTitle>
        {hint && <p className="text-xs text-muted-foreground sm:text-[13px]">{hint}</p>}
      </CardHeader>
    </Card>
  );
}

/** Check-based availability, with its definition next to it. */
export const AVAILABILITY_HINT =
  'Check-based: successful checks ÷ checks that count. Excludes checks RAIN refused to send; paused or unmonitored time is not counted.';

export function PerformanceCharts({
  series,
  range,
}: {
  series: AnalyticsBucket[];
  range: AnalyticsRange;
}) {
  const values = <K extends keyof AnalyticsBucket>(key: K) =>
    series.map((b) => b[key] as number | null);
  const bucketHours = ANALYTICS_RANGE_CONFIG[range].bucketSeconds / 3600;
  const per =
    bucketHours >= 24 ? 'per day' : bucketHours === 1 ? 'per hour' : `per ${bucketHours} hours`;
  return (
    <div className="stagger grid gap-4 xl:grid-cols-2">
      <TimeSeriesChart
        title="Availability history"
        description={`Check-based availability ${per}. Gaps mean no counted checks in that period.`}
        buckets={series}
        range={range}
        kind="line"
        yMax={100}
        format={(v) => `${Math.round(v * 10) / 10}%`}
        series={[
          {
            key: 'availability',
            label: 'Availability',
            color: SERIES_COLORS[0],
            values: values('availabilityPercent'),
          },
        ]}
        emptyMessage="No checks counted in this period"
      />
      <TimeSeriesChart
        title="Response time"
        description={`Average and P95 latency ${per}, from checks that received a response.`}
        buckets={series}
        range={range}
        kind="line"
        format={formatLatency}
        series={[
          { key: 'avg', label: 'Average', color: SERIES_COLORS[0], values: values('avgLatencyMs') },
          { key: 'p95', label: 'P95', color: SERIES_COLORS[1], values: values('p95LatencyMs') },
        ]}
        emptyMessage="No responses recorded in this period"
      />
      <TimeSeriesChart
        title="Check activity"
        description={`Successful and failed checks ${per} (refused checks not included).`}
        buckets={series}
        range={range}
        kind="stacked"
        integer
        format={(v) => formatCount(Math.round(v))}
        series={[
          {
            key: 'successful',
            label: 'Successful',
            color: SERIES_COLORS[0],
            values: values('successful'),
          },
          { key: 'failed', label: 'Failed', color: SERIES_COLORS[1], values: values('failed') },
        ]}
        emptyMessage="No checks recorded in this period"
      />
      <TimeSeriesChart
        title="Incident history"
        description={`Incidents opened and resolved ${per}.`}
        buckets={series}
        range={range}
        kind="grouped"
        integer
        format={(v) => formatCount(Math.round(v))}
        series={[
          {
            key: 'opened',
            label: 'Opened',
            color: SERIES_COLORS[0],
            values: values('incidentsOpened'),
          },
          {
            key: 'resolved',
            label: 'Resolved',
            color: SERIES_COLORS[1],
            values: values('incidentsResolved'),
          },
        ]}
        emptyMessage="No incidents opened or resolved in this period"
      />
    </div>
  );
}

export function LatencyCard({ latency }: { latency: LatencyStats }) {
  const items: Array<[string, number | null]> = [
    ['Average', latency.avgMs],
    ['Minimum', latency.minMs],
    ['Maximum', latency.maxMs],
    ['P50 (median)', latency.p50Ms],
    ['P95', latency.p95Ms],
    ['P99', latency.p99Ms],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Response time</CardTitle>
        <CardDescription>
          {latency.samples === 0
            ? 'No check received a response in this period.'
            : `From ${formatCount(latency.samples)} checks that received a response (unexpected statuses included; timeouts and connection failures have no latency).`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {items.map(([label, value]) => (
            <div key={label} className="grid gap-0.5">
              <dt className="text-[11px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
                {label}
              </dt>
              <dd
                className="font-display text-xl font-semibold tabular-nums"
                aria-label={`${label}: ${formatLatency(value)}`}
              >
                {formatLatency(value)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function FailureCard({
  checks,
  reasons,
}: {
  checks: CheckStats;
  reasons: FailureReasonCount[];
}) {
  const counted = reasons.filter((r) => !r.excludedFromAvailability);
  const excluded = reasons.filter((r) => r.excludedFromAvailability);
  const facts: Array<[string, string]> = [
    ['Counted checks', formatCount(checks.eligible)],
    ['Successful', formatCount(checks.successful)],
    ['Failed', formatCount(checks.failed)],
    ['Failure rate', formatPercent(checks.failurePercent)],
    ['Slow (expected status)', formatCount(checks.slow)],
    ['Refused by RAIN (excluded)', formatCount(checks.excluded)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Failures</CardTitle>
        <CardDescription>
          Failed checks by reason, using the monitoring engine's own categories.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label} className="grid gap-0.5">
              <dt className="text-[11px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
                {label}
              </dt>
              <dd className="font-display text-xl font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {counted.length === 0 && excluded.length === 0 ? (
          <p className="text-sm text-muted-foreground">No failed checks in this period.</p>
        ) : (
          <Table aria-label="Failure reasons">
            <thead className="bg-muted/30">
              <tr>
                <Th>Reason</Th>
                <Th className="text-right">Checks</Th>
                <Th className="hidden text-right sm:table-cell">Share of failures</Th>
              </tr>
            </thead>
            <tbody>
              {counted.map((r) => (
                <tr key={r.reason} className="border-t border-border">
                  <Td>{FAILURE_REASON_LABELS[r.reason]}</Td>
                  <Td className="text-right tabular-nums">{formatCount(r.count)}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">
                    {formatPercent(checks.failed ? (r.count / checks.failed) * 100 : null)}
                  </Td>
                </tr>
              ))}
              {excluded.map((r) => (
                <tr key={r.reason} className="border-t border-border text-muted-foreground">
                  <Td>{FAILURE_REASON_LABELS[r.reason]} (excluded from availability)</Td>
                  <Td className="text-right tabular-nums">{formatCount(r.count)}</Td>
                  <Td className="hidden text-right sm:table-cell">—</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function IncidentStatsCard({ incidents }: { incidents: IncidentStats }) {
  const facts: Array<[string, string]> = [
    ['Opened in period', formatCount(incidents.opened)],
    ['Resolved in period', formatCount(incidents.resolved)],
    ['Open now', formatCount(incidents.currentlyOpen)],
    ['Average resolution time', formatDurationMs(incidents.averageResolutionMs)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Incidents</CardTitle>
        <CardDescription>
          Resolution time is measured from start to resolution, for incidents resolved in this
          period. Open incidents are not included.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4">
          {facts.map(([label, value]) => (
            <div key={label} className="grid gap-0.5">
              <dt className="text-[11px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
                {label}
              </dt>
              <dd
                className="font-display text-xl font-semibold tabular-nums"
                aria-label={`${label}: ${value}`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
