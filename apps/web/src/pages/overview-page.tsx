import type { AnalyticsOverview } from '@rain/shared';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ListChecks,
  Plus,
  RefreshCw,
  Siren,
  UserRound,
} from 'lucide-react';
import { Link } from 'react-router';
import { Accent, ErrorState, PageHeader } from '@/components/page';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  IconBadge,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useMe } from '@/features/account/use-me';
import { StatCard } from '@/features/analytics/analytics-sections';
import { useAnalyticsOverview } from '@/features/analytics/api';
import { formatAvailability, formatCount, formatLatency } from '@/features/analytics/format';
import { useIncidentList } from '@/features/incidents/api';
import { IncidentTable } from '@/features/incidents/incident-table';
import { useMonitorList } from '@/features/monitors/api';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function OverviewPage() {
  const me = useMe();
  const health = useAnalyticsOverview('24h');
  const refreshing = me.isFetching || health.isFetching;

  return (
    <div className="grid gap-6 sm:gap-7">
      <PageHeader
        eyebrow="Overview"
        title={
          <>
            API Health <Accent>at a Glance</Accent>
          </>
        }
        description="The health of your APIs over the last 24 hours, from recorded checks."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void me.refetch();
              void health.refetch();
            }}
            disabled={refreshing}
            className="[&:hover_svg]:rotate-90"
          >
            {refreshing ? (
              <Spinner label="Refreshing" />
            ) : (
              <RefreshCw aria-hidden className="duration-500!" />
            )}
            Refresh
          </Button>
        }
      />

      {health.isPending ? (
        <HealthSkeleton />
      ) : health.isError && !health.data ? (
        <ErrorState
          title="Couldn't load monitor health"
          error={health.error}
          onRetry={() => void health.refetch()}
          retrying={health.isFetching}
        />
      ) : health.data && health.data.monitors.total > 0 ? (
        <HealthSummary data={health.data} />
      ) : null}

      <div className="stagger grid gap-6 xl:grid-cols-3">
        <div className="stagger grid content-start gap-6 xl:col-span-2">
          <ActiveIncidents />
          <MonitorsSummary />
        </div>
        <div className="grid content-start gap-6">
          <AccountCard me={me} />
        </div>
      </div>
    </div>
  );
}

function HealthSkeleton() {
  return (
    <div className="grid gap-4" aria-busy>
      <Skeleton className="h-40 rounded-2xl" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

const SEGMENTS = [
  { key: 'healthy', label: 'Healthy', bar: 'bg-status-healthy' },
  { key: 'degraded', label: 'Degraded', bar: 'bg-status-degraded' },
  { key: 'down', label: 'Down', bar: 'bg-status-down' },
  { key: 'unknown', label: 'Not checked yet', bar: 'bg-status-unknown' },
  { key: 'paused', label: 'Paused', bar: 'bg-foreground/70' },
] as const;

/** One headline from the stored monitor statuses (no new health rule: just which status leads). */
function headline(m: AnalyticsOverview['monitors']) {
  if (m.down > 0)
    return { text: `${m.down} monitor${m.down === 1 ? ' is' : 's are'} down`, tone: 'down' };
  if (m.degraded > 0)
    return {
      text: `${m.degraded} monitor${m.degraded === 1 ? ' is' : 's are'} degraded`,
      tone: 'degraded',
    };
  if (m.healthy > 0) return { text: 'All checked monitors are healthy', tone: 'healthy' };
  return { text: 'Waiting for the first checks', tone: 'unknown' };
}

const HEADLINE_TONE = {
  down: { text: 'text-status-down-fg', dot: 'bg-status-down' },
  degraded: { text: 'text-status-degraded-fg', dot: 'bg-status-degraded' },
  healthy: { text: 'text-status-healthy-fg', dot: 'bg-status-healthy' },
  unknown: { text: 'text-muted-foreground', dot: 'bg-status-unknown' },
} as const;

function HealthSummary({ data }: { data: AnalyticsOverview }) {
  const m = data.monitors;
  const { text, tone } = headline(m);
  const toneStyle = HEADLINE_TONE[tone as keyof typeof HEADLINE_TONE];
  // Paused monitors keep their last stored status, so the bar shows them on their own.
  const counts = {
    healthy: m.healthy,
    degraded: m.degraded,
    down: m.down,
    unknown: m.unknown,
    paused: m.paused,
  };
  const segmentTotal = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const series = data.series;

  return (
    <section aria-label="Monitor health" className="stagger grid gap-4 sm:gap-5">
      <Card className="card-lift relative overflow-hidden">
        <CardContent className="relative grid gap-5 p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                Current status
              </p>
              <p
                className={cn(
                  'mt-2 flex items-center gap-3 text-2xl font-bold tracking-tight sm:text-3xl',
                  toneStyle.text,
                )}
              >
                <span aria-hidden className="relative flex size-3.5 shrink-0">
                  {tone !== 'healthy' && tone !== 'unknown' && (
                    <span
                      className={cn(
                        'absolute inset-0 animate-soft-ping rounded-full',
                        toneStyle.dot,
                      )}
                    />
                  )}
                  <span className={cn('relative size-3.5 rounded-full', toneStyle.dot)} />
                </span>
                {text}
              </p>
            </div>
            <Button asChild variant="outline">
              <Link to="/app/monitors">
                {formatCount(m.total)} monitors <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
          <div
            className="h-3.5 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={SEGMENTS.map((s) => `${counts[s.key]} ${s.label.toLowerCase()}`).join(', ')}
          >
            <div className="flex size-full origin-left animate-grow-x gap-0.5">
              {SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
                <span
                  key={s.key}
                  className={cn('h-full transition-[width] duration-700', s.bar)}
                  style={{ width: `${(counts[s.key] / segmentTotal) * 100}%` }}
                />
              ))}
            </div>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {SEGMENTS.map((s) => (
              <li key={s.key} className="flex items-center gap-2 font-medium text-foreground/80">
                <span aria-hidden className={cn('size-2.5 rounded-full', s.bar)} />
                {s.label}
                <span className="font-bold text-foreground tabular-nums">{counts[s.key]}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="stagger grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Availability"
          tone="healthy"
          icon={Activity}
          value={formatAvailability(data.checks.availabilityPercent)}
          trend={series.map((b) => b.availabilityPercent)}
          hint="Check-based, last 24 hours"
        />
        <StatCard
          label="P95 response"
          tone="primary"
          icon={Clock3}
          value={formatLatency(data.latency.p95Ms)}
          trend={series.map((b) => b.p95LatencyMs)}
          hint={`Median ${formatLatency(data.latency.p50Ms)}`}
        />
        <StatCard
          label="Failed checks"
          icon={ListChecks}
          tone={data.checks.failed > 0 ? 'degraded' : 'healthy'}
          value={formatCount(data.checks.failed)}
          trend={series.map((b) => b.failed)}
          hint={`of ${formatCount(data.checks.eligible)} counted`}
        />
        <StatCard
          label="Active incidents"
          icon={Siren}
          tone={data.incidents.currentlyOpen > 0 ? 'down' : 'healthy'}
          value={formatCount(data.incidents.currentlyOpen)}
          trend={series.map((b) => b.incidentsOpened)}
          hint={
            <Link to="/app/analytics" className="relative z-10 hover:text-primary">
              Open analytics
            </Link>
          }
        />
      </div>
    </section>
  );
}

function ActiveIncidents() {
  const list = useIncidentList({ status: 'ACTIVE' }, 5);
  const incidents = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <IconBadge className="bg-status-down/12 text-status-down-fg">
            <Siren />
          </IconBadge>
          <div className="grid gap-1">
            <CardTitle className="text-lg">Active incidents</CardTitle>
            <CardDescription>Open incidents across your monitors, newest first.</CardDescription>
          </div>
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to="/app/incidents">
            All incidents <ArrowRight aria-hidden />
          </Link>
        </Button>
      </CardHeader>
      {list.isPending ? (
        <CardContent className="grid gap-2" aria-busy>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </CardContent>
      ) : list.isError ? (
        <CardContent>
          <ErrorState
            title="Couldn't load incidents"
            error={list.error}
            onRetry={() => void list.refetch()}
            retrying={list.isFetching}
          />
        </CardContent>
      ) : incidents.length === 0 ? (
        <CardContent>
          <div className="flex items-center gap-3 rounded-xl border border-status-healthy/25 bg-status-healthy/8 px-4 py-3 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-status-healthy-fg" aria-hidden />
            No active incidents. Everything that was reported has been resolved.
          </div>
        </CardContent>
      ) : (
        <div className="px-0 pb-2 sm:px-3 sm:pb-3">
          <div className="overflow-hidden sm:rounded-xl">
            <IncidentTable incidents={incidents} label="Active incidents" />
          </div>
        </div>
      )}
    </Card>
  );
}

/** A count of configured monitors from the API. */
function MonitorsSummary() {
  const list = useMonitorList({
    search: '',
    state: 'all',
    status: undefined,
    cursor: undefined,
    limit: 1,
  });
  const used = list.data?.quota.used;

  return (
    <Card className="card-lift">
      <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:py-6">
        <div className="flex items-center gap-4">
          <IconBadge className="size-12">
            <Activity />
          </IconBadge>
          <div>
            <h2 className="text-lg font-bold">Monitors</h2>
            <p className="text-sm text-muted-foreground">
              {list.isPending
                ? 'Loading…'
                : list.isError
                  ? "Couldn't load your monitors."
                  : used === 0
                    ? 'No monitors yet. Add the endpoints you want RAIN to watch.'
                    : `${used} of ${list.data.quota.limit} monitors configured.`}
            </p>
          </div>
        </div>
        <Button asChild>
          {used === 0 ? (
            <Link to="/app/monitors/new">
              <Plus aria-hidden /> Add monitor
            </Link>
          ) : (
            <Link to="/app/monitors">
              View monitors <ArrowRight aria-hidden />
            </Link>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function AccountCard({ me }: { me: ReturnType<typeof useMe> }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <IconBadge>
            <UserRound />
          </IconBadge>
          <div className="grid gap-1">
            <CardTitle className="text-lg">Account</CardTitle>
            <CardDescription className="flex items-start gap-2">
              <span
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  me.isSuccess
                    ? 'bg-status-healthy'
                    : me.isError
                      ? 'bg-status-down'
                      : 'animate-pulse bg-status-unknown',
                )}
                aria-hidden
              />
              {me.isSuccess
                ? 'Connected: authenticated requests to the RAIN API are working.'
                : me.isError
                  ? 'The RAIN API rejected or could not serve the request.'
                  : 'Checking the API connection…'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {me.isPending ? (
          <div className="grid gap-4" aria-busy>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : me.isError ? (
          <Alert variant="error">
            <p>{me.error.message}</p>
            {me.error instanceof ApiError && me.error.requestId && (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                Request ID: {me.error.requestId}
              </p>
            )}
          </Alert>
        ) : (
          <dl className="grid gap-4">
            <Detail label="Email" value={me.data.email ?? '—'} />
            <Detail label="Display name" value={me.data.profile.displayName ?? 'Not set'} />
            <Detail
              label="Member since"
              value={dateFormat.format(new Date(me.data.profile.createdAt))}
            />
            <Detail label="User ID" value={me.data.id} mono />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1">
      <dt className="text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className={mono ? 'truncate font-mono text-xs' : 'truncate text-sm font-semibold'}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
