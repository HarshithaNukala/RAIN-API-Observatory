import {
  ManualCheckQueuedSchema,
  MonitorCheckListResponseSchema,
  MonitorListResponseSchema,
  MonitorResponseSchema,
  MonitorUpdateResponseSchema,
  type CreateMonitorInput,
  type Monitor,
  type MonitorCheck,
  type MonitorCheckSource,
  type MonitorHeaderUpdateInput,
  type MonitorStatus,
  type UpdateMonitorInput,
} from '@rain/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/auth-context';

export type MonitorStateFilter = 'all' | 'enabled' | 'paused';

export const MONITOR_PAGE_SIZE = 20;

export interface MonitorListParams {
  search: string;
  state: MonitorStateFilter;
  status: MonitorStatus | undefined;
  cursor: string | undefined;
  limit: number;
}

/** Stable, hierarchical keys: invalidating `all` refreshes every monitor query. */
export const monitorKeys = {
  all: ['monitors'] as const,
  lists: () => [...monitorKeys.all, 'list'] as const,
  list: (params: MonitorListParams) => [...monitorKeys.lists(), params] as const,
  detail: (id: string) => [...monitorKeys.all, 'detail', id] as const,
  checks: (id: string) => [...monitorKeys.all, 'checks', id] as const,
  checkPage: (id: string, source: MonitorCheckSource | undefined) =>
    [...monitorKeys.checks(id), source ?? 'ALL'] as const,
};

/** Health is written by the worker, so screens showing it refresh on their own. */
export const HEALTH_REFRESH_MS = 30_000;
export const CHECK_PAGE_SIZE = 25;

const base = '/api/v1/monitors';
const path = (id: string, suffix = '') => `${base}/${encodeURIComponent(id)}${suffix}`;

export function listPath(params: MonitorListParams): string {
  const query = new URLSearchParams({ limit: String(params.limit), state: params.state });
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  return `${base}?${query.toString()}`;
}

export function useMonitorList(params: MonitorListParams) {
  const { api } = useAuth();
  return useQuery({
    queryKey: monitorKeys.list(params),
    queryFn: () => api.get(listPath(params), MonitorListResponseSchema),
    // Keep the current page on screen while the next page or filter loads.
    placeholderData: keepPreviousData,
    refetchInterval: HEALTH_REFRESH_MS,
  });
}

export function useMonitor(id: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: monitorKeys.detail(id),
    queryFn: () => api.get(path(id), MonitorResponseSchema),
    refetchInterval: HEALTH_REFRESH_MS,
  });
}

export function checksPath(
  id: string,
  params: { source?: MonitorCheckSource | undefined; cursor?: string | undefined; limit: number },
): string {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.source) query.set('source', params.source);
  if (params.cursor) query.set('cursor', params.cursor);
  return path(id, `/checks?${query.toString()}`);
}

/** Check history, newest first, one page at a time ("Load more"). */
export function useMonitorChecks(id: string, source?: MonitorCheckSource) {
  const { api } = useAuth();
  return useInfiniteQuery({
    queryKey: monitorKeys.checkPage(id, source),
    queryFn: ({ pageParam }) =>
      api.get(
        checksPath(id, { source, cursor: pageParam, limit: CHECK_PAGE_SIZE }),
        MonitorCheckListResponseSchema,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: HEALTH_REFRESH_MS,
  });
}

export const CHECK_NOW_POLL_MS = 1000;
/** Longest a queued check can take: a poll, a 30 s timeout, completion, with margin. */
export const CHECK_NOW_MAX_WAIT_MS = 45_000;

export type CheckNowState =
  | { phase: 'idle' }
  | { phase: 'queueing' }
  | { phase: 'queued'; queuedAt: string }
  | { phase: 'done'; check: MonitorCheck }
  /** Still queued after the bounded wait: probably no worker running. */
  | { phase: 'timeout'; queuedAt: string }
  | { phase: 'error'; error: Error };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check Now: asks the API to queue a manual check (it never sends the request itself), then polls
 * the monitor until the worker has run it, and shows that check. The wait is bounded.
 */
export function useCheckNow(
  monitor: Pick<Monitor, 'id' | 'lastManualCheckAt'>,
  options: { pollMs?: number; maxWaitMs?: number } = {},
) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [state, setState] = useState<CheckNowState>({ phase: 'idle' });
  const alive = useRef(true);
  const pollMs = options.pollMs ?? CHECK_NOW_POLL_MS;
  const maxWaitMs = options.maxWaitMs ?? CHECK_NOW_MAX_WAIT_MS;
  const { id, lastManualCheckAt } = monitor;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    const previous = lastManualCheckAt;
    setState({ phase: 'queueing' });
    try {
      const queued = await api.post(path(id, '/check'), ManualCheckQueuedSchema);
      if (!alive.current) return;
      setState({ phase: 'queued', queuedAt: queued.queuedAt });
      await queryClient.invalidateQueries({ queryKey: monitorKeys.detail(id) });

      const deadline = Date.now() + maxWaitMs;
      let failures = 0;
      while (alive.current && Date.now() < deadline) {
        await sleep(pollMs);
        if (!alive.current) return;
        let current: Monitor;
        try {
          current = await api.get(path(id), MonitorResponseSchema);
          failures = 0;
        } catch (err) {
          // A blip while polling isn't the check's result; give up only if it persists.
          if (++failures >= 3) throw err;
          continue;
        }
        queryClient.setQueryData(monitorKeys.detail(id), current);
        if (current.manualCheckQueuedAt) continue;

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: monitorKeys.checks(id) }),
          queryClient.invalidateQueries({ queryKey: monitorKeys.lists() }),
        ]);
        if (!alive.current) return;
        if (current.lastManualCheckAt === previous) {
          setState({
            phase: 'error',
            error: new Error(
              'The queued check was cancelled before it ran (the monitor was paused).',
            ),
          });
          return;
        }
        const latest = await api.get(
          checksPath(id, { source: 'MANUAL', limit: 1 }),
          MonitorCheckListResponseSchema,
        );
        if (!alive.current) return;
        const check = latest.items[0];
        setState(
          check
            ? { phase: 'done', check }
            : { phase: 'error', error: new Error('The check result could not be found.') },
        );
        return;
      }
      if (alive.current) setState({ phase: 'timeout', queuedAt: queued.queuedAt });
    } catch (err) {
      if (alive.current) setState({ phase: 'error', error: err as Error });
    }
  }, [api, id, lastManualCheckAt, maxWaitMs, pollMs, queryClient]);

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  const busy = state.phase === 'queueing' || state.phase === 'queued';
  return { state, start, reset, busy };
}

/** After any change: store the fresh monitor and refetch lists, whose order and counts moved. */
function useMonitorChanged() {
  const queryClient = useQueryClient();
  return async (monitor: Monitor) => {
    queryClient.setQueryData(monitorKeys.detail(monitor.id), monitor);
    await queryClient.invalidateQueries({ queryKey: monitorKeys.lists() });
  };
}

export function useCreateMonitor() {
  const { api } = useAuth();
  const changed = useMonitorChanged();
  return useMutation({
    mutationFn: (input: CreateMonitorInput) => api.post(base, MonitorResponseSchema, input),
    onSuccess: changed,
    meta: { inlineErrors: true },
  });
}

export function useUpdateMonitor(id: string) {
  const { api } = useAuth();
  const changed = useMonitorChanged();
  return useMutation({
    mutationFn: (patch: UpdateMonitorInput) =>
      api.patchWithMeta(path(id), MonitorUpdateResponseSchema, patch),
    onSuccess: (result) => changed(result.data),
    meta: { inlineErrors: true },
  });
}

export function useUpdateMonitorHeaders(id: string) {
  const { api } = useAuth();
  const changed = useMonitorChanged();
  return useMutation({
    mutationFn: (update: MonitorHeaderUpdateInput) =>
      api.patch(path(id, '/headers'), MonitorResponseSchema, update),
    onSuccess: changed,
    meta: { inlineErrors: true },
  });
}

export function useSetMonitorEnabled() {
  const { api } = useAuth();
  const changed = useMonitorChanged();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post(path(id, enabled ? '/resume' : '/pause'), MonitorResponseSchema),
    onSuccess: changed,
  });
}

export function useDeleteMonitor() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(path(id));
      return id;
    },
    onSuccess: async (id) => {
      queryClient.removeQueries({ queryKey: monitorKeys.detail(id) });
      await queryClient.invalidateQueries({ queryKey: monitorKeys.lists() });
    },
    meta: { inlineErrors: true },
  });
}
