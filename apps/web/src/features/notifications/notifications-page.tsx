import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationStatus,
} from '@rain/shared';
import { BellRing, RotateCcw, SearchX } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorState, PageHeader } from '@/components/page';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, Select, Table, Td, Th } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatRelative } from '@/features/monitors/format';
import {
  useNotification,
  useNotificationList,
  useRetryNotification,
  type NotificationFilters,
} from './api';
import { CHANNEL_LABELS, EVENT_LABELS, STATUS_LABELS, STATUS_TONE } from './format';

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso)}
    </time>
  );
}

export function DeliveryStatusBadge({ status }: { status: NotificationStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>;
}

function DeliveryTable({ items }: { items: NotificationDelivery[] }) {
  return (
    <Table aria-label="Notification deliveries">
      <thead className="bg-muted/30">
        <tr>
          <Th>Event</Th>
          <Th className="hidden md:table-cell">Monitor</Th>
          <Th className="hidden lg:table-cell">Incident</Th>
          <Th className="hidden sm:table-cell">Channel</Th>
          <Th>Status</Th>
          <Th className="hidden sm:table-cell">Attempts</Th>
          <Th className="hidden xl:table-cell">Last attempt</Th>
          <Th className="hidden xl:table-cell">Delivered</Th>
          <Th className="hidden lg:table-cell">Error</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id} className="border-t border-border hover:bg-accent/30">
            <Td>
              <Link
                to={`/app/notifications/${d.id}`}
                className="font-medium whitespace-nowrap hover:text-primary"
              >
                {EVENT_LABELS[d.eventType]}
              </Link>
              <span className="block text-xs text-muted-foreground md:hidden">
                {d.monitor.name}
                {/* The channel column is hidden on phones: name the channel here instead. */}
                <span className="sm:hidden"> · {CHANNEL_LABELS[d.channel]}</span>
              </span>
            </Td>
            <Td className="hidden md:table-cell">
              <Link to={`/app/monitors/${d.monitor.id}`} className="hover:text-primary">
                {d.monitor.name}
              </Link>
            </Td>
            <Td className="hidden max-w-56 lg:table-cell">
              <Link
                to={`/app/incidents/${d.incident.id}`}
                className="block truncate hover:text-primary"
              >
                {d.incident.title}
              </Link>
            </Td>
            <Td className="hidden whitespace-nowrap sm:table-cell">
              {CHANNEL_LABELS[d.channel]}
              <span className="block font-mono text-xs text-muted-foreground">{d.destination}</span>
            </Td>
            <Td>
              <DeliveryStatusBadge status={d.status} />
            </Td>
            <Td className="hidden tabular-nums sm:table-cell">
              {d.attempts} / {d.maxAttempts}
            </Td>
            <Td className="hidden whitespace-nowrap xl:table-cell">
              <When iso={d.lastAttemptedAt} />
            </Td>
            <Td className="hidden whitespace-nowrap xl:table-cell">
              <When iso={d.deliveredAt} />
            </Td>
            <Td className="hidden max-w-64 lg:table-cell">
              <span
                className="block truncate text-xs text-muted-foreground"
                title={d.lastError ?? undefined}
              >
                {d.lastError ?? '—'}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function parse<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const filters: NotificationFilters = {
    status: parse(params.get('status'), NOTIFICATION_STATUSES),
    channel: parse(params.get('channel'), NOTIFICATION_CHANNELS),
    monitorId: params.get('monitorId') ?? undefined,
  };
  const list = useNotificationList(filters);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const filtered = Boolean(filters.status || filters.channel || filters.monitorId);

  function setFilter(key: keyof NotificationFilters, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Notifications"
        description="Every email and webhook RAIN queued for your incidents, and what happened to it. Configure channels on each monitor's Notifications tab."
      />
      <div className="flex flex-wrap items-end gap-3">
        <Select
          aria-label="Filter by delivery status"
          value={filters.status ?? ''}
          onChange={(e) => setFilter('status', e.target.value || undefined)}
        >
          <option value="">All statuses</option>
          {NOTIFICATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by channel"
          value={filters.channel ?? ''}
          onChange={(e) =>
            setFilter('channel', (e.target.value || undefined) as NotificationChannel | undefined)
          }
        >
          <option value="">All channels</option>
          {NOTIFICATION_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </Select>
        {filters.monitorId && (
          <Button variant="outline" size="sm" onClick={() => setFilter('monitorId', undefined)}>
            One monitor · Show all monitors
          </Button>
        )}
      </div>

      {list.isPending ? (
        <Card aria-busy>
          <div className="grid gap-2 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        </Card>
      ) : list.isError && items.length === 0 ? (
        <ErrorState
          title="Couldn't load notifications"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={BellRing}
            title={filtered ? 'No matching notifications' : 'No notifications yet'}
          >
            {filtered
              ? 'No deliveries match these filters.'
              : 'Turn on email or a webhook on a monitor; deliveries appear here when its incidents open or resolve.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <DeliveryTable items={items} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground">
            <span>
              Showing {items.length} of {total}
            </span>
            {list.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage && <Spinner label="Loading" />}
                Load more
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

export function NotificationDetailPage() {
  const id = useParams().notificationId ?? '';
  const query = useNotification(id);
  const retry = useRetryNotification(id);
  const crumbs = { label: 'Notifications', to: '/app/notifications' };
  const d = query.data;

  if (query.isPending) {
    return (
      <div className="grid gap-6" aria-busy>
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (query.isError || !d) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="grid gap-6">
        <PageHeader title="Notification" breadcrumbs={[crumbs, { label: 'Not available' }]} />
        {notFound ? (
          <Card>
            <EmptyState icon={SearchX} title="Notification not found">
              It may have been removed with its monitor, or the link is wrong.
            </EmptyState>
          </Card>
        ) : (
          <ErrorState
            title="Couldn't load the notification"
            error={query.error ?? new Error('Not available')}
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
        breadcrumbs={[
          crumbs,
          { label: `${EVENT_LABELS[d.eventType]} · ${CHANNEL_LABELS[d.channel]}` },
        ]}
        title={`${EVENT_LABELS[d.eventType]} · ${CHANNEL_LABELS[d.channel]}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <DeliveryStatusBadge status={d.status} />
            <span className="font-mono text-xs">{d.destination}</span>
          </span>
        }
        actions={
          d.status === 'FAILED' ? (
            <Button
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(undefined, { onSuccess: () => toast.success('Delivery queued again') })
              }
            >
              {retry.isPending ? <Spinner label="Retrying" /> : <RotateCcw aria-hidden />}
              Retry delivery
            </Button>
          ) : undefined
        }
      />
      {retry.isError && <Alert variant="error">{retry.error.message}</Alert>}
      {d.lastError && d.status !== 'SENT' && (
        <Alert variant={d.status === 'FAILED' ? 'error' : 'info'}>{d.lastError}</Alert>
      )}
      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-5 sm:grid-cols-3">
            {(
              [
                [
                  'Monitor',
                  <Link key="m" to={`/app/monitors/${d.monitor.id}`} className="hover:text-primary">
                    {d.monitor.name}
                  </Link>,
                ],
                [
                  'Incident',
                  <Link
                    key="i"
                    to={`/app/incidents/${d.incident.id}`}
                    className="hover:text-primary"
                  >
                    {d.incident.title}
                  </Link>,
                ],
                ['Attempts', `${d.attempts} of ${d.maxAttempts}`],
                ['Queued', <When key="q" iso={d.createdAt} />],
                ['Last attempt', <When key="l" iso={d.lastAttemptedAt} />],
                [
                  d.status === 'PENDING' ? 'Next attempt' : 'Delivered',
                  <When key="n" iso={d.status === 'PENDING' ? d.nextAttemptAt : d.deliveredAt} />,
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="grid gap-1">
                <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
                <dd className="text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">Attempts</CardTitle>
          <CardDescription>
            Each try to deliver this notification. Delivery is at-least-once: a receiver may see a
            delivery ID twice.
          </CardDescription>
        </CardHeader>
        {d.attemptHistory.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">Not attempted yet.</p>
          </CardContent>
        ) : (
          <Table aria-label="Delivery attempts">
            <thead className="bg-muted/30">
              <tr>
                <Th>#</Th>
                <Th>Result</Th>
                <Th className="hidden sm:table-cell">HTTP</Th>
                <Th>Time</Th>
                <Th className="hidden md:table-cell">Error</Th>
              </tr>
            </thead>
            <tbody>
              {d.attemptHistory.map((a) => (
                <tr key={a.attemptNumber} className="border-t border-border">
                  <Td className="tabular-nums">{a.attemptNumber}</Td>
                  <Td>
                    <Badge
                      tone={
                        a.outcome === 'SUCCESS'
                          ? 'success'
                          : a.outcome === 'TEMPORARY_FAILURE'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      {a.outcome === 'SUCCESS'
                        ? 'Delivered'
                        : a.outcome === 'TEMPORARY_FAILURE'
                          ? 'Temporary failure'
                          : 'Permanent failure'}
                    </Badge>
                  </Td>
                  <Td className="hidden tabular-nums sm:table-cell">{a.httpStatus ?? '—'}</Td>
                  <Td className="whitespace-nowrap">{formatDateTime(a.startedAt)}</Td>
                  <Td className="hidden text-xs text-muted-foreground md:table-cell">
                    {a.error ?? '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
