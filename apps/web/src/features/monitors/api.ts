import {
  MonitorListResponseSchema,
  MonitorResponseSchema,
  MonitorUpdateResponseSchema,
  type CreateMonitorInput,
  type Monitor,
  type MonitorHeaderUpdateInput,
  type MonitorStatus,
  type UpdateMonitorInput,
} from '@rain/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
};

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
  });
}

export function useMonitor(id: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: monitorKeys.detail(id),
    queryFn: () => api.get(path(id), MonitorResponseSchema),
  });
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
