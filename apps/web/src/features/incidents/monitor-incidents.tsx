import { Siren } from 'lucide-react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/page';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelative } from '@/features/monitors/format';
import { useIncidentList } from './api';
import { IncidentStatusBadge } from './badges';
import { IncidentTable } from './incident-table';

const RECENT = 5;

/** On a monitor's page: its active incident (if any) and its recent incident history. */
export function MonitorIncidents({ monitorId }: { monitorId: string }) {
  const list = useIncidentList({ monitorId }, RECENT);
  const incidents = list.data?.pages[0]?.items ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  // At most one incident per monitor is active, and it is always the newest.
  const active = incidents[0] && incidents[0].status !== 'RESOLVED' ? incidents[0] : undefined;

  return (
    <div className="grid gap-4">
      {active && (
        <Alert variant="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <Siren className="size-4" aria-hidden /> Active incident: {active.title}
                <IncidentStatusBadge status={active.status} />
              </p>
              <p className="text-muted-foreground">Started {formatRelative(active.startedAt)}</p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to={`/app/incidents/${active.id}`}>View incident</Link>
            </Button>
          </div>
        </Alert>
      )}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Incidents</CardTitle>
          <CardDescription>Outages detected on this monitor, newest first.</CardDescription>
        </CardHeader>
        {list.isPending ? (
          <CardContent>
            <Skeleton className="h-16" />
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
            <p className="text-sm text-muted-foreground">No incidents for this monitor.</p>
          </CardContent>
        ) : (
          <>
            <IncidentTable incidents={incidents} label="Monitor incidents" showMonitor={false} />
            {total > incidents.length && (
              <div className="border-t border-border px-4 py-3">
                <Button asChild variant="outline" size="sm">
                  <Link to={`/app/incidents?monitorId=${monitorId}`}>
                    View all {total} incidents
                  </Link>
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
