import type { Monitor } from '@rain/shared';
import {
  Activity,
  Clock,
  History,
  KeyRound,
  Pause,
  Pencil,
  Play,
  SearchX,
  Trash2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorState, PageHeader } from '@/components/page';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api-client';
import { useMonitor } from './api';
import { byteLength, formatBytes, formatDateTime, formatInterval, formatRelative } from './format';
import { DeleteMonitorDialog } from './monitor-actions';
import { usePauseResume } from './use-pause-resume';
import { MonitorForm } from './monitor-form';
import { MonitorStateBadges } from './status-badge';

const monitorsCrumb = { label: 'Monitors', to: '/app/monitors' };

function useMonitorIdParam(): string {
  return useParams().monitorId ?? '';
}

function LoadingPage() {
  return (
    <div className="grid gap-6" aria-busy>
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** Not found (or someone else's monitor: the API answers both the same way) and load errors. */
function MonitorLoadError({
  error,
  retry,
  retrying,
}: {
  error: Error;
  retry: () => void;
  retrying: boolean;
}) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Card>
        <EmptyState
          icon={SearchX}
          title="Monitor not found"
          action={
            <Button asChild variant="outline">
              <Link to="/app/monitors">Back to monitors</Link>
            </Button>
          }
        >
          It may have been deleted, or the link is wrong.
        </EmptyState>
      </Card>
    );
  }
  return (
    <ErrorState
      title="Couldn't load the monitor"
      error={error}
      onRetry={retry}
      retrying={retrying}
    />
  );
}

export function NewMonitorPage() {
  const navigate = useNavigate();
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Add monitor"
        description="Configure an API endpoint for RAIN to watch."
        breadcrumbs={[monitorsCrumb, { label: 'New monitor' }]}
      />
      <MonitorForm
        onCancel={() => void navigate('/app/monitors')}
        onSaved={(monitor) => {
          toast.success(`Created “${monitor.name}”`);
          void navigate(`/app/monitors/${monitor.id}`);
        }}
      />
    </div>
  );
}

export function EditMonitorPage() {
  const id = useMonitorIdParam();
  const navigate = useNavigate();
  const query = useMonitor(id);
  // Bumped to rebuild the form from the server's state after a destination change cleared it.
  const [formVersion, setFormVersion] = useState(0);
  const [clearedNotice, setClearedNotice] = useState(false);

  return (
    <div className="grid gap-6">
      <PageHeader
        title={query.data ? `Edit ${query.data.name}` : 'Edit monitor'}
        breadcrumbs={[
          monitorsCrumb,
          ...(query.data ? [{ label: query.data.name, to: `/app/monitors/${id}` }] : []),
          { label: 'Edit' },
        ]}
      />
      {clearedNotice && (
        <Alert variant="info">
          The destination changed, so the saved authentication headers and request body were
          removed. Add the credentials for the new destination below.
        </Alert>
      )}
      {query.isPending ? (
        <LoadingPage />
      ) : query.isError ? (
        <MonitorLoadError
          error={query.error}
          retry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <MonitorForm
          key={`${query.data.id}-${formVersion}`}
          monitor={query.data}
          onCancel={() => void navigate(`/app/monitors/${id}`)}
          onSaved={(monitor, { savedConfigurationCleared }) => {
            if (savedConfigurationCleared) {
              toast.success('Destination updated');
              setClearedNotice(true);
              setFormVersion((v) => v + 1);
              return;
            }
            toast.success(`Saved “${monitor.name}”`);
            void navigate(`/app/monitors/${monitor.id}`);
          }}
        />
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function OverviewTab({ monitor }: { monitor: Monitor }) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Stored status</CardDescription>
            <div className="pt-1">
              <MonitorStateBadges status={monitor.currentStatus} enabled={monitor.enabled} />
            </div>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Last checked</CardDescription>
            <CardTitle className="text-sm font-medium">
              {monitor.lastCheckedAt ? (
                <time
                  dateTime={monitor.lastCheckedAt}
                  title={formatDateTime(monitor.lastCheckedAt)}
                >
                  {formatRelative(monitor.lastCheckedAt)}
                </time>
              ) : (
                'Never'
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Next scheduled check</CardDescription>
            <CardTitle className="text-sm font-medium">
              {!monitor.enabled || !monitor.nextCheckAt
                ? 'None while paused'
                : formatDateTime(monitor.nextCheckAt)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      <Card className="border-dashed bg-transparent">
        <EmptyState icon={History} title="No check history yet">
          RAIN stores this monitor's configuration, but health checks are not running yet. Response
          times, uptime and incidents will appear here once the monitoring engine is enabled. Until
          then the status stays <strong>Unknown</strong> unless a real check has recorded one.
        </EmptyState>
      </Card>
    </div>
  );
}

function ConfigurationTab({ monitor }: { monitor: Monitor }) {
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Endpoint">
              <span className="font-mono text-xs">{monitor.url}</span>
            </Detail>
            <Detail label="HTTP method">
              <span className="font-mono">{monitor.method}</span>
            </Detail>
            <Detail label="Expected status">{monitor.expectedStatusCode}</Detail>
            <Detail label="Timeout">{monitor.timeoutMs.toLocaleString()} ms</Detail>
            <Detail label="Latency threshold">
              {monitor.latencyThresholdMs.toLocaleString()} ms
            </Detail>
            <Detail label="Check interval">
              Every {formatInterval(monitor.checkIntervalSeconds)}
            </Detail>
            <Detail label="Request body">
              {monitor.requestBody === null
                ? 'None'
                : `Configured · ${formatBytes(byteLength(monitor.requestBody))} · ${monitor.bodyContentType ?? ''}`}
            </Detail>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Authentication headers</CardTitle>
          <CardDescription>
            Values are encrypted and never shown. Replace or remove them from the edit page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {monitor.headers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No headers configured.</p>
          ) : (
            <ul className="grid gap-2">
              {monitor.headers.map((h) => (
                <li
                  key={h.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="flex items-center gap-2 font-mono text-sm">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                    {h.name}
                  </span>
                  <Badge tone="success">Credential configured</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Record</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 sm:grid-cols-3">
            <Detail label="Created">{formatDateTime(monitor.createdAt)}</Detail>
            <Detail label="Last updated">{formatDateTime(monitor.updatedAt)}</Detail>
            <Detail label="Monitor ID">
              <span className="font-mono text-xs">{monitor.id}</span>
            </Detail>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

export function MonitorDetailPage() {
  const id = useMonitorIdParam();
  const navigate = useNavigate();
  const query = useMonitor(id);
  const { pendingId, toggle } = usePauseResume();
  const [deleting, setDeleting] = useState(false);
  const monitor = query.data;

  if (query.isPending) return <LoadingPage />;
  if (query.isError || !monitor) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Monitor" breadcrumbs={[monitorsCrumb, { label: 'Not available' }]} />
        <MonitorLoadError
          error={query.error ?? new Error('Monitor not available')}
          retry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }

  const toggling = pendingId === monitor.id;
  return (
    <div className="grid gap-6">
      <PageHeader
        breadcrumbs={[monitorsCrumb, { label: monitor.name }]}
        title={monitor.name}
        description={
          <span className="flex flex-col gap-2">
            {monitor.description && <span>{monitor.description}</span>}
            <span className="flex flex-wrap items-center gap-2">
              <MonitorStateBadges status={monitor.currentStatus} enabled={monitor.enabled} />
              <span className="font-mono text-xs">
                {monitor.method} {monitor.url}
              </span>
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="outline" disabled={toggling} onClick={() => toggle(monitor)}>
              {toggling ? (
                <Spinner label="Updating" />
              ) : monitor.enabled ? (
                <Pause aria-hidden />
              ) : (
                <Play aria-hidden />
              )}
              {monitor.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button asChild variant="outline">
              <Link to={`/app/monitors/${monitor.id}/edit`}>
                <Pencil aria-hidden /> Edit
              </Link>
            </Button>
            <Button variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2 aria-hidden /> Delete
            </Button>
          </>
        }
      />

      {!monitor.enabled && (
        <Alert variant="info">
          This monitor is paused. Its configuration and last known status are kept; resume it to
          schedule checks again.
        </Alert>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">
            <span className="flex items-center gap-2">
              <Activity className="size-4" aria-hidden /> Overview
            </span>
          </TabsTrigger>
          <TabsTrigger value="configuration">
            <span className="flex items-center gap-2">
              <Clock className="size-4" aria-hidden /> Configuration
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab monitor={monitor} />
        </TabsContent>
        <TabsContent value="configuration">
          <ConfigurationTab monitor={monitor} />
        </TabsContent>
      </Tabs>

      <DeleteMonitorDialog
        monitor={deleting ? monitor : null}
        onOpenChange={setDeleting}
        onDeleted={() => void navigate('/app/monitors', { replace: true })}
      />
    </div>
  );
}
