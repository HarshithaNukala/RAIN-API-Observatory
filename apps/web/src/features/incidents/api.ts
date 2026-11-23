import {
  IncidentCountsSchema,
  IncidentEventListResponseSchema,
  IncidentListResponseSchema,
  IncidentSchema,
  type Incident,
  type IncidentSeverity,
  type IncidentStatusFilter,
  type UpdateIncidentInput,
} from '@rain/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/auth-context';

export const INCIDENT_PAGE_SIZE = 20;
/** Incidents open and resolve in the worker, so screens showing them refresh on their own. */
export const INCIDENT_REFRESH_MS = 30_000;

export interface IncidentFilters {
  status?: IncidentStatusFilter | undefined;
  severity?: IncidentSeverity | undefined;
  monitorId?: string | undefined;
}

export const incidentKeys = {
  all: ['incidents'] as const,
  lists: () => [...incidentKeys.all, 'list'] as const,
  list: (filters: IncidentFilters, limit: number) =>
    [...incidentKeys.lists(), filters, limit] as const,
  counts: (monitorId?: string) => [...incidentKeys.all, 'counts', monitorId ?? 'all'] as const,
  detail: (id: string) => [...incidentKeys.all, 'detail', id] as const,
  events: (id: string) => [...incidentKeys.all, 'events', id] as const,
};

const base = '/api/v1/incidents';
const path = (id: string, suffix = '') => `${base}/${encodeURIComponent(id)}${suffix}`;

export function incidentListPath(filters: IncidentFilters, limit: number, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (filters.status) query.set('status', filters.status);
  if (filters.severity) query.set('severity', filters.severity);
  if (filters.monitorId) query.set('monitorId', filters.monitorId);
  if (cursor) query.set('cursor', cursor);
  return `${base}?${query.toString()}`;
}

/** Newest first, one page at a time ("Load more"). */
export function useIncidentList(filters: IncidentFilters, limit = INCIDENT_PAGE_SIZE) {
  const { api } = useAuth();
  return useInfiniteQuery({
    queryKey: incidentKeys.list(filters, limit),
    queryFn: ({ pageParam }) =>
      api.get(incidentListPath(filters, limit, pageParam), IncidentListResponseSchema),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: INCIDENT_REFRESH_MS,
  });
}

export function useIncidentCounts(monitorId?: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: incidentKeys.counts(monitorId),
    queryFn: () =>
      api.get(
        monitorId ? `${base}/counts?monitorId=${encodeURIComponent(monitorId)}` : `${base}/counts`,
        IncidentCountsSchema,
      ),
    refetchInterval: INCIDENT_REFRESH_MS,
  });
}

export function useIncident(id: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: incidentKeys.detail(id),
    queryFn: () => api.get(path(id), IncidentSchema),
    refetchInterval: INCIDENT_REFRESH_MS,
  });
}

/** The timeline, oldest first. */
export function useIncidentEvents(id: string) {
  const { api } = useAuth();
  return useInfiniteQuery({
    queryKey: incidentKeys.events(id),
    queryFn: ({ pageParam }) =>
      api.get(
        path(id, `/events?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
        IncidentEventListResponseSchema,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: INCIDENT_REFRESH_MS,
  });
}

/** After a change: store the incident and refresh lists, counts and its timeline. */
function useIncidentChanged() {
  const queryClient = useQueryClient();
  return async (incident: Incident) => {
    queryClient.setQueryData(incidentKeys.detail(incident.id), incident);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: incidentKeys.lists() }),
      queryClient.invalidateQueries({ queryKey: [...incidentKeys.all, 'counts'] }),
      queryClient.invalidateQueries({ queryKey: incidentKeys.events(incident.id) }),
    ]);
  };
}

export function useAcknowledgeIncident(id: string) {
  const { api } = useAuth();
  const changed = useIncidentChanged();
  return useMutation({
    mutationFn: () => api.post(path(id, '/acknowledge'), IncidentSchema),
    onSuccess: changed,
    meta: { inlineErrors: true },
  });
}

export function useUpdateIncident(id: string) {
  const { api } = useAuth();
  const changed = useIncidentChanged();
  return useMutation({
    mutationFn: (patch: UpdateIncidentInput) => api.patch(path(id), IncidentSchema, patch),
    onSuccess: changed,
    meta: { inlineErrors: true },
  });
}
