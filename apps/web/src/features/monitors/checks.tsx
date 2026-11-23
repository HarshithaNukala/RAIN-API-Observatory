import type { MonitorCheck, MonitorCheckSource } from '@rain/shared';
import { History, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, Select, Table, Td, Th } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useMonitorChecks } from './api';
import {
  FAILURE_REASON_LABELS,
  OUTCOME_LABELS,
  SOURCE_LABELS,
  formatDateTime,
  formatRelative,
} from './format';

const OUTCOME_TONE = { SUCCESS: 'success', DEGRADED: 'warning', FAILURE: 'danger' } as const;

export function OutcomeBadge({ check }: { check: MonitorCheck }) {
  return (
    <Badge tone={OUTCOME_TONE[check.outcome]}>
      {check.failureReason
        ? FAILURE_REASON_LABELS[check.failureReason]
        : OUTCOME_LABELS[check.outcome]}
    </Badge>
  );
}

const statusText = (check: MonitorCheck) =>
  check.statusCode === null ? 'No response' : `HTTP ${check.statusCode}`;
const latencyText = (check: MonitorCheck) =>
  check.latencyMs === null ? '—' : `${check.latencyMs.toLocaleString()} ms`;

/** One check's facts: when, outcome, HTTP status, latency and the sanitised error. */
export function CheckResult({ check }: { check: MonitorCheck }) {
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge check={check} />
        <span>{statusText(check)}</span>
        <span className="text-muted-foreground">· {latencyText(check)}</span>
        <span className="text-muted-foreground">
          ·{' '}
          <time dateTime={check.checkedAt} title={formatDateTime(check.checkedAt)}>
            {formatRelative(check.checkedAt)}
          </time>{' '}
          ({SOURCE_LABELS[check.source].toLowerCase()})
        </span>
      </div>
      {check.errorMessage && (
        <p className="font-mono text-xs break-words text-muted-foreground">{check.errorMessage}</p>
      )}
    </div>
  );
}

/** The most recent recorded check, straight from history. */
export function LastCheckCard({ monitorId }: { monitorId: string }) {
  const checks = useMonitorChecks(monitorId);
  const latest = checks.data?.pages[0]?.items[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last check</CardTitle>
        <CardDescription>The latest result the monitoring worker recorded.</CardDescription>
      </CardHeader>
      <CardContent>
        {checks.isPending ? (
          <Skeleton className="h-10" />
        ) : checks.isError ? (
          <ErrorState
            title="Couldn't load the last check"
            error={checks.error}
            onRetry={() => void checks.refetch()}
            retrying={checks.isFetching}
          />
        ) : latest ? (
          <CheckResult check={latest} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No check has run yet. The status stays Unknown until the first one completes.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const SOURCE_FILTERS = [
  { value: '', label: 'All checks' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'MANUAL', label: 'Manual' },
] as const;

export function CheckHistory({ monitorId }: { monitorId: string }) {
  const [source, setSource] = useState<MonitorCheckSource | undefined>(undefined);
  const checks = useMonitorChecks(monitorId, source);
  const items = checks.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Show</span>
          <Select
            aria-label="Filter checks by source"
            value={source ?? ''}
            onChange={(e) =>
              setSource((e.target.value || undefined) as MonitorCheckSource | undefined)
            }
          >
            {SOURCE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={checks.isFetching}
          onClick={() => void checks.refetch()}
        >
          {checks.isFetching ? <Spinner label="Refreshing" /> : <RefreshCw aria-hidden />}
          Refresh
        </Button>
      </div>

      {checks.isPending ? (
        <Card aria-busy>
          <div className="grid gap-2 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        </Card>
      ) : checks.isError ? (
        <ErrorState
          title="Couldn't load the check history"
          error={checks.error}
          onRetry={() => void checks.refetch()}
          retrying={checks.isFetching}
        />
      ) : items.length === 0 ? (
        <Card className="border-dashed bg-transparent">
          <EmptyState icon={History} title="No checks yet">
            {source
              ? `No ${SOURCE_LABELS[source].toLowerCase()} checks have been recorded.`
              : 'Checks appear here as the monitoring worker runs them.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table aria-label="Check history">
            <thead className="bg-muted/30">
              <tr>
                <Th>Checked</Th>
                <Th>Result</Th>
                <Th className="hidden sm:table-cell">HTTP status</Th>
                <Th className="hidden sm:table-cell">Latency</Th>
                <Th className="hidden md:table-cell">Source</Th>
                <Th className="hidden lg:table-cell">Details</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((check) => (
                <tr key={check.id} className="border-t border-border">
                  <Td className="whitespace-nowrap">
                    <time dateTime={check.checkedAt} title={formatDateTime(check.checkedAt)}>
                      {formatDateTime(check.checkedAt)}
                    </time>
                  </Td>
                  <Td>
                    <OutcomeBadge check={check} />
                  </Td>
                  <Td className="hidden sm:table-cell">
                    {check.statusCode ?? <span className="text-muted-foreground">No response</span>}
                  </Td>
                  <Td className="hidden sm:table-cell">{latencyText(check)}</Td>
                  <Td className="hidden md:table-cell">{SOURCE_LABELS[check.source]}</Td>
                  <Td className="hidden max-w-96 lg:table-cell">
                    <span
                      className="block truncate font-mono text-xs text-muted-foreground"
                      title={check.errorMessage ?? undefined}
                    >
                      {check.errorMessage ?? '—'}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {checks.hasNextPage && (
            <div className="flex justify-center border-t border-border px-4 py-3">
              <Button
                variant="outline"
                size="sm"
                disabled={checks.isFetchingNextPage}
                onClick={() => void checks.fetchNextPage()}
              >
                {checks.isFetchingNextPage && <Spinner label="Loading" />}
                Load older checks
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
