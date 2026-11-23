import { MONITOR_STATUSES, type MonitorStatus, type MonitorSummary } from '@rain/shared';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Eye,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  SearchX,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, Table, Td, Th } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { MONITOR_PAGE_SIZE as PAGE_SIZE, useMonitorList, type MonitorStateFilter } from './api';
import { formatDateTime, formatInterval, formatRelative, statusLabel } from './format';
import { DeleteMonitorDialog } from './monitor-actions';
import { usePauseResume } from './use-pause-resume';
import { MonitorStateBadges } from './status-badge';

const STATE_FILTERS: Array<{ value: MonitorStateFilter; label: string }> = [
  { value: 'all', label: 'Active and paused' },
  { value: 'enabled', label: 'Active only' },
  { value: 'paused', label: 'Paused only' },
];

const isStatus = (v: string | null): v is MonitorStatus =>
  v !== null && (MONITOR_STATUSES as readonly string[]).includes(v);
const isState = (v: string | null): v is MonitorStateFilter =>
  v === 'all' || v === 'enabled' || v === 'paused';

/** Search text applied to the URL after typing pauses, so each keystroke doesn't hit the API. */
function useDebouncedSearch(applied: string, apply: (value: string) => void) {
  const [text, setText] = useState(applied);
  // When the URL changes from elsewhere (e.g. "Clear filters"), show the new search text.
  const [lastApplied, setLastApplied] = useState(applied);
  if (applied !== lastApplied) {
    setLastApplied(applied);
    setText(applied);
  }
  useEffect(() => {
    if (text.trim() === applied) return;
    const timer = setTimeout(() => apply(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text, applied, apply]);
  return [text, setText] as const;
}

function RowActions({
  monitor,
  pending,
  onToggle,
  onDelete,
}: {
  monitor: MonitorSummary;
  pending: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${monitor.name}`}>
          {pending ? <Spinner label="Updating" /> : <MoreHorizontal aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => void navigate(`/app/monitors/${monitor.id}`)}>
          <Eye aria-hidden /> View
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate(`/app/monitors/${monitor.id}/edit`)}>
          <Pencil aria-hidden /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={onToggle}>
          {monitor.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
          {monitor.enabled ? 'Pause' : 'Resume'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onDelete}>
          <Trash2 aria-hidden /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonRows() {
  return (
    <tbody aria-busy>
      {Array.from({ length: 5 }, (_, i) => (
        <tr key={i} className="border-t border-border">
          <Td colSpan={8}>
            <Skeleton className="h-6" />
          </Td>
        </tr>
      ))}
    </tbody>
  );
}

export function MonitorsPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const statusParam = params.get('status');
  const status = isStatus(statusParam) ? statusParam : undefined;
  const stateParam = params.get('state');
  const state = isState(stateParam) ? stateParam : 'all';
  const filtered = Boolean(search || status || state !== 'all');

  function setFilter(key: 'q' | 'status' | 'state', value: string | undefined) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  const [searchText, setSearchText] = useDebouncedSearch(search, (v) =>
    setFilter('q', v || undefined),
  );

  // Cursor pagination: a stack of cursors for the pages before this one, reset by any filter.
  const filterKey = JSON.stringify([search, status, state]);
  const [pages, setPages] = useState<{ key: string; cursors: string[] }>({
    key: filterKey,
    cursors: [],
  });
  const cursors = pages.key === filterKey ? pages.cursors : [];

  const list = useMonitorList({
    search,
    status,
    state,
    cursor: cursors.at(-1),
    limit: PAGE_SIZE,
  });
  const { pendingId, toggle } = usePauseResume();
  const [toDelete, setToDelete] = useState<MonitorSummary | null>(null);

  const data = list.data;
  const quotaReached = data ? data.quota.used >= data.quota.limit : false;
  const firstItem = cursors.length * PAGE_SIZE + 1;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Monitors"
        breadcrumbs={[{ label: 'Overview', to: '/app' }, { label: 'Monitors' }]}
        description={
          data
            ? `${data.quota.used} of ${data.quota.limit} monitors used`
            : 'The APIs RAIN is configured to watch.'
        }
        actions={
          <Button asChild={!quotaReached} disabled={quotaReached}>
            {quotaReached ? (
              <span title="Monitor limit reached. Delete a monitor to add another.">
                <Plus aria-hidden /> Add monitor
              </span>
            ) : (
              <Link to="/app/monitors/new">
                <Plus aria-hidden /> Add monitor
              </Link>
            )}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[1fr_auto_auto]">
        <div className="relative col-span-2 lg:col-span-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search monitors by name"
            placeholder="Search by name"
            value={searchText}
            maxLength={100}
            onChange={(e) => setSearchText(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          aria-label="Filter by status"
          value={status ?? ''}
          onChange={(e) => setFilter('status', e.target.value || undefined)}
        >
          <option value="">All statuses</option>
          {MONITOR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by state"
          value={state}
          onChange={(e) =>
            setFilter('state', e.target.value === 'all' ? undefined : e.target.value)
          }
        >
          {STATE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>

      {list.isError && !data ? (
        <ErrorState
          title="Couldn't load monitors"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : data && data.total === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No monitors match these filters"
              action={
                <Button variant="outline" onClick={() => setParams({}, { replace: true })}>
                  Clear filters
                </Button>
              }
            >
              Try a different name or status.
            </EmptyState>
          ) : (
            <EmptyState
              icon={Activity}
              title="No monitors yet"
              action={
                <Button asChild>
                  <Link to="/app/monitors/new">
                    <Plus aria-hidden /> Add your first monitor
                  </Link>
                </Button>
              }
            >
              Add the API endpoints you want RAIN to watch. Each monitor shows Unknown until its
              first check has run.
            </EmptyState>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table aria-label="Monitors" aria-busy={list.isFetching}>
            <thead className="bg-muted/30">
              <tr>
                <Th>Monitor</Th>
                <Th className="hidden xl:table-cell">Endpoint</Th>
                <Th className="hidden sm:table-cell">Method</Th>
                <Th className="hidden sm:table-cell">Status</Th>
                <Th className="hidden xl:table-cell">Interval</Th>
                <Th className="hidden lg:table-cell">Last checked</Th>
                <Th className="hidden 2xl:table-cell">Next check</Th>
                <Th className="w-12">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            {!data ? (
              <SkeletonRows />
            ) : (
              <tbody className={cn(list.isPlaceholderData && 'opacity-60')}>
                {data.items.map((m) => (
                  <tr key={m.id} className="border-t border-border hover:bg-accent/30">
                    {/* On phones this column takes the remaining width and also shows status. */}
                    <Td className="w-full max-w-0 sm:w-auto sm:max-w-56">
                      <Link
                        to={`/app/monitors/${m.id}`}
                        className="block truncate font-medium hover:text-primary"
                      >
                        {m.name}
                      </Link>
                      <span className="block truncate font-mono text-xs text-muted-foreground xl:hidden">
                        {m.url}
                      </span>
                      <span className="mt-1.5 block sm:hidden">
                        <MonitorStateBadges status={m.currentStatus} enabled={m.enabled} />
                      </span>
                    </Td>
                    <Td className="hidden max-w-72 xl:table-cell">
                      <span className="block truncate font-mono text-xs" title={m.url}>
                        {m.url}
                      </span>
                    </Td>
                    <Td className="hidden font-mono text-xs sm:table-cell">{m.method}</Td>
                    <Td className="hidden sm:table-cell">
                      <MonitorStateBadges status={m.currentStatus} enabled={m.enabled} />
                    </Td>
                    <Td className="hidden text-muted-foreground xl:table-cell">
                      Every {formatInterval(m.checkIntervalSeconds)}
                    </Td>
                    <Td className="hidden text-muted-foreground lg:table-cell">
                      {m.lastCheckedAt ? (
                        <time dateTime={m.lastCheckedAt}>{formatRelative(m.lastCheckedAt)}</time>
                      ) : (
                        'Never'
                      )}
                    </Td>
                    <Td className="hidden text-muted-foreground 2xl:table-cell">
                      {!m.enabled || !m.nextCheckAt ? (
                        '—'
                      ) : m.manualCheckQueuedAt ? (
                        'Queued now'
                      ) : (
                        <time dateTime={m.nextCheckAt} title={formatDateTime(m.nextCheckAt)}>
                          {formatRelative(m.nextCheckAt)}
                        </time>
                      )}
                    </Td>
                    <Td>
                      <RowActions
                        monitor={m}
                        pending={pendingId === m.id}
                        onToggle={() => toggle(m)}
                        onDelete={() => setToDelete(m)}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            )}
          </Table>
          {data && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground">
              <span>
                Showing {firstItem}–{firstItem + data.items.length - 1} of {data.total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cursors.length === 0 || list.isFetching}
                  onClick={() => setPages({ key: filterKey, cursors: cursors.slice(0, -1) })}
                >
                  <ChevronLeft aria-hidden /> Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!data.nextCursor || list.isFetching}
                  onClick={() =>
                    data.nextCursor &&
                    setPages({ key: filterKey, cursors: [...cursors, data.nextCursor] })
                  }
                >
                  Next <ChevronRight aria-hidden />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <DeleteMonitorDialog monitor={toDelete} onOpenChange={(open) => !open && setToDelete(null)} />
    </div>
  );
}
