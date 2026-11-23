import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUS_FILTERS,
  type IncidentSeverity,
  type IncidentStatusFilter,
} from '@rain/shared';
import { ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useIncidentCounts, useIncidentList, type IncidentFilters } from './api';
import { INCIDENT_STATUS_LABELS, SEVERITY_LABELS } from './format';
import { IncidentTable } from './incident-table';

const STATUS_FILTER_LABELS: Record<IncidentStatusFilter, string> = {
  ...INCIDENT_STATUS_LABELS,
  ACTIVE: 'Active (open or acknowledged)',
};

function CountCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | undefined;
  /** Top accent in the matching status colour. */
  accent: string;
}) {
  return (
    <Card className="relative overflow-hidden transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-border-strong">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 opacity-80 ${accent}`} />
      <CardHeader className="gap-1.5 p-4 sm:p-5">
        <CardDescription className="text-[11px] font-bold tracking-[0.1em] uppercase">
          {label}
        </CardDescription>
        <CardTitle
          className="font-display text-2xl font-semibold tabular-nums"
          aria-label={`${label}: ${value ?? '…'}`}
        >
          {value === undefined ? <Skeleton className="h-8 w-12" /> : value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function parse<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

export function IncidentsPage() {
  const [params, setParams] = useSearchParams();
  const filters: IncidentFilters = {
    status: parse(params.get('status'), INCIDENT_STATUS_FILTERS),
    severity: parse(params.get('severity'), INCIDENT_SEVERITIES),
    monitorId: params.get('monitorId') ?? undefined,
  };
  const counts = useIncidentCounts();
  const list = useIncidentList(filters);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  const filtered = Boolean(filters.status || filters.severity || filters.monitorId);
  const monitorName = filters.monitorId ? items[0]?.monitor.name : undefined;

  function setFilter(key: 'status' | 'severity' | 'monitorId', value: string | undefined) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Incidents"
        description="Outages RAIN detected on your monitors. Incidents open when a monitor goes down and resolve after it has recovered."
      />

      <section aria-label="Incident counts" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {counts.isError ? (
          <div className="col-span-2 lg:col-span-4">
            <ErrorState
              title="Couldn't load incident counts"
              error={counts.error}
              onRetry={() => void counts.refetch()}
              retrying={counts.isFetching}
            />
          </div>
        ) : (
          <>
            <CountCard label="Total" value={counts.data?.total} accent="bg-primary" />
            <CountCard label="Open" value={counts.data?.open} accent="bg-status-down" />
            <CountCard
              label="Acknowledged"
              value={counts.data?.acknowledged}
              accent="bg-status-degraded"
            />
            <CountCard label="Resolved" value={counts.data?.resolved} accent="bg-status-healthy" />
          </>
        )}
      </section>

      <div className="flex flex-wrap items-end gap-3">
        <Select
          aria-label="Filter by incident status"
          value={filters.status ?? ''}
          onChange={(e) => setFilter('status', e.target.value || undefined)}
        >
          <option value="">All statuses</option>
          {INCIDENT_STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {STATUS_FILTER_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by severity"
          value={filters.severity ?? ''}
          onChange={(e) =>
            setFilter('severity', (e.target.value || undefined) as IncidentSeverity | undefined)
          }
        >
          <option value="">All severities</option>
          {INCIDENT_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABELS[s]}
            </option>
          ))}
        </Select>
        {filters.monitorId && (
          <Button variant="outline" size="sm" onClick={() => setFilter('monitorId', undefined)}>
            {monitorName ? `Monitor: ${monitorName}` : 'One monitor'} · Show all monitors
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
          title="Couldn't load incidents"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={ShieldCheck}
            title={filtered ? 'No matching incidents' : 'No incidents yet'}
          >
            {filtered
              ? 'No incidents match these filters.'
              : 'When a monitor goes down, RAIN opens an incident here automatically.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <IncidentTable incidents={items} />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground">
            <span>
              Showing {items.length} of {total ?? items.length}
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
          {list.isError && (
            <p
              role="alert"
              className="border-t border-border px-4 py-3 text-sm font-semibold text-status-down-fg"
            >
              Couldn't load more incidents: {list.error.message}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
