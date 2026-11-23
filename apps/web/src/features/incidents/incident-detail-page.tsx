import {
  INCIDENT_LIMITS,
  INCIDENT_SEVERITIES,
  type Incident,
  type IncidentEvent,
  type IncidentSeverity,
} from '@rain/shared';
import { Bot, CheckCheck, Pencil, SearchX, User } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorState, PageHeader } from '@/components/page';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, Textarea } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatRelative } from '@/features/monitors/format';
import { MonitorStateBadges } from '@/features/monitors/status-badge';
import { useAcknowledgeIncident, useIncident, useIncidentEvents, useUpdateIncident } from './api';
import { IncidentStatusBadge, SeverityBadge } from './badges';
import { EVENT_LABELS, SEVERITY_LABELS, formatDuration } from './format';

const incidentsCrumb = { label: 'Incidents', to: '/app/incidents' };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatRelative(iso)}>
      {formatDateTime(iso)}
    </time>
  );
}

function Timeline({ incidentId }: { incidentId: string }) {
  const events = useIncidentEvents(incidentId);
  const items: IncidentEvent[] = events.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>A permanent record of what happened, oldest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {events.isPending ? (
          <div className="grid gap-3" aria-busy>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : events.isError ? (
          <ErrorState
            title="Couldn't load the timeline"
            error={events.error}
            onRetry={() => void events.refetch()}
            retrying={events.isFetching}
          />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events recorded.</p>
        ) : (
          <ol aria-label="Incident timeline" className="grid gap-4 border-l border-border pl-5">
            {items.map((event) => (
              <li key={event.id} className="relative grid gap-1">
                <span
                  className="absolute top-1 -left-[1.6rem] flex size-4 items-center justify-center rounded-full bg-background"
                  aria-hidden
                >
                  {event.actor === 'USER' ? (
                    <User className="size-3.5 text-primary" />
                  ) : (
                    <Bot className="size-3.5 text-muted-foreground" />
                  )}
                </span>
                <p className="text-sm font-medium">
                  {EVENT_LABELS[event.type]}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {event.actor === 'USER' ? 'by you' : 'by RAIN'} ·{' '}
                    <When iso={event.occurredAt} />
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">{event.description}</p>
              </li>
            ))}
          </ol>
        )}
        {events.hasNextPage && (
          <Button
            className="mt-4"
            variant="outline"
            size="sm"
            disabled={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
          >
            {events.isFetchingNextPage && <Spinner label="Loading" />}
            Load later events
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function EditIncident({ incident, onDone }: { incident: Incident; onDone: () => void }) {
  const update = useUpdateIncident(incident.id);
  const [title, setTitle] = useState(incident.title);
  const [description, setDescription] = useState(incident.description ?? '');
  const [severity, setSeverity] = useState<IncidentSeverity>(incident.severity);
  const titleIssue =
    update.error instanceof ApiError
      ? update.error.issues.find((i) => i.path === 'title')?.message
      : undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    update.mutate(
      { title, description, severity },
      {
        onSuccess: () => {
          toast.success('Incident updated');
          onDone();
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit incident</CardTitle>
        <CardDescription>
          Status changes come from the monitoring engine and acknowledgement.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label="Title"
            value={title}
            maxLength={INCIDENT_LIMITS.titleMaxLength}
            onChange={(e) => setTitle(e.target.value)}
            error={titleIssue}
            required
          />
          <div className="grid gap-2">
            <Label htmlFor="incident-description">Description</Label>
            <Textarea
              id="incident-description"
              className="font-sans"
              value={description}
              maxLength={INCIDENT_LIMITS.descriptionMaxLength}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="incident-severity">Severity</Label>
            <Select
              id="incident-severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
            >
              {INCIDENT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          {update.isError && !titleIssue && <Alert variant="error">{update.error.message}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Spinner label="Saving" />}
              Save changes
            </Button>
            <Button type="button" variant="outline" onClick={onDone} disabled={update.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function IncidentDetailPage() {
  const id = useParams().incidentId ?? '';
  const query = useIncident(id);
  const acknowledge = useAcknowledgeIncident(id);
  const [editing, setEditing] = useState(false);
  const incident = query.data;

  if (query.isPending) {
    return (
      <div className="grid gap-6" aria-busy>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (query.isError || !incident) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="grid gap-6">
        <PageHeader title="Incident" breadcrumbs={[incidentsCrumb, { label: 'Not available' }]} />
        {notFound ? (
          <Card>
            <EmptyState
              icon={SearchX}
              title="Incident not found"
              action={
                <Button asChild variant="outline">
                  <Link to="/app/incidents">Back to incidents</Link>
                </Button>
              }
            >
              It may have been removed with its monitor, or the link is wrong.
            </EmptyState>
          </Card>
        ) : (
          <ErrorState
            title="Couldn't load the incident"
            error={query.error ?? new Error('Incident not available')}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        breadcrumbs={[incidentsCrumb, { label: incident.title }]}
        title={incident.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <IncidentStatusBadge status={incident.status} />
            <SeverityBadge severity={incident.severity} />
          </span>
        }
        actions={
          <>
            {incident.status === 'OPEN' && (
              <Button
                disabled={acknowledge.isPending}
                onClick={() =>
                  acknowledge.mutate(undefined, {
                    onSuccess: () => toast.success('Incident acknowledged'),
                  })
                }
              >
                {acknowledge.isPending ? (
                  <Spinner label="Acknowledging" />
                ) : (
                  <CheckCheck aria-hidden />
                )}
                Acknowledge
              </Button>
            )}
            {!editing && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden /> Edit
              </Button>
            )}
          </>
        }
      />

      {acknowledge.isError && <Alert variant="error">{acknowledge.error.message}</Alert>}

      {editing && <EditIncident incident={incident} onDone={() => setEditing(false)} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <p className="text-sm whitespace-pre-wrap">
              {incident.description ?? (
                <span className="text-muted-foreground">No description.</span>
              )}
            </p>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Fact label="Started">
                <When iso={incident.startedAt} />
              </Fact>
              <Fact label="Duration">
                {formatDuration(incident.startedAt, incident.resolvedAt)}
                {!incident.resolvedAt && ' (ongoing)'}
              </Fact>
              <Fact label="Acknowledged">
                {incident.acknowledgedAt ? (
                  <>
                    <When iso={incident.acknowledgedAt} /> by you
                  </>
                ) : (
                  'Not acknowledged'
                )}
              </Fact>
              <Fact label="Resolved">
                {incident.resolvedAt ? <When iso={incident.resolvedAt} /> : 'Not resolved yet'}
              </Fact>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Monitor</CardDescription>
            <CardTitle className="text-base">
              <Link to={`/app/monitors/${incident.monitor.id}`} className="hover:text-primary">
                {incident.monitor.name}
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div>
              <p className="mb-1 text-xs tracking-wide text-muted-foreground uppercase">
                Current health
              </p>
              <MonitorStateBadges
                status={incident.monitor.currentStatus}
                enabled={incident.monitor.enabled}
              />
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to={`/app/monitors/${incident.monitor.id}`}>View monitoring details</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Timeline incidentId={incident.id} />
    </div>
  );
}
