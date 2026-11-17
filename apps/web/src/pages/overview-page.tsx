import { Activity, ArrowRight, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';
import { useMe } from '@/features/account/use-me';
import { useMonitorList } from '@/features/monitors/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-sm' : 'truncate text-sm'} title={value}>
        {value}
      </dd>
    </div>
  );
}

export function OverviewPage() {
  const me = useMe();

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your RAIN workspace and account at a glance.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void me.refetch()}
          disabled={me.isFetching}
        >
          {me.isFetching ? <Spinner label="Refreshing" /> : <RefreshCw aria-hidden />}
          Refresh
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden />
              Account
            </CardTitle>
            <CardDescription>Verified by the RAIN API from your Supabase session.</CardDescription>
          </CardHeader>
          <CardContent>
            {me.isPending ? (
              <div className="grid gap-4 sm:grid-cols-2" aria-busy>
                {Array.from({ length: 4 }, (_, i) => (
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
              <dl className="grid gap-5 sm:grid-cols-2">
                <Detail label="Email" value={me.data.email ?? '—'} />
                <Detail label="Display name" value={me.data.profile.displayName ?? 'Not set'} />
                <Detail label="User ID" value={me.data.id} mono />
                <Detail
                  label="Member since"
                  value={dateFormat.format(new Date(me.data.profile.createdAt))}
                />
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span
                className={
                  me.isSuccess
                    ? 'size-2 rounded-full bg-success'
                    : me.isError
                      ? 'size-2 rounded-full bg-destructive'
                      : 'size-2 rounded-full bg-muted-foreground'
                }
                aria-hidden
              />
              API connection
            </CardTitle>
            <CardDescription>
              {me.isSuccess
                ? 'Authenticated requests to the RAIN API are working.'
                : me.isError
                  ? 'The RAIN API rejected or could not serve the request.'
                  : 'Checking…'}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <MonitorsSummary />
    </div>
  );
}

/** A count of configured monitors from the API. No health figures until checks exist. */
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
    <Card>
      <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="flex size-11 items-center justify-center rounded-full bg-primary/10">
            <Activity className="size-5 text-primary" aria-hidden />
          </span>
          <div>
            <h2 className="text-base font-semibold">Monitors</h2>
            <p className="text-sm text-muted-foreground">
              {list.isPending
                ? 'Loading…'
                : list.isError
                  ? "Couldn't load your monitors."
                  : used === 0
                    ? 'No monitors yet. Add the endpoints you want RAIN to watch.'
                    : `${used} of ${list.data.quota.limit} monitors configured. Health checks start once the monitoring engine is enabled.`}
            </p>
          </div>
        </div>
        <Button asChild variant={used === 0 ? 'default' : 'outline'}>
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
