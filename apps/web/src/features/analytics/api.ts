import { AnalyticsOverviewSchema, MonitorMetricsSchema, type AnalyticsRange } from '@rain/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/auth/auth-context';

/** Analytics move as checks arrive, so they refresh on their own (like health screens). */
export const ANALYTICS_REFRESH_MS = 60_000;

export const analyticsKeys = {
  all: ['analytics'] as const,
  overview: (range: AnalyticsRange) => [...analyticsKeys.all, 'overview', range] as const,
  monitor: (id: string, range: AnalyticsRange) =>
    [...analyticsKeys.all, 'monitor', id, range] as const,
};

export function useAnalyticsOverview(range: AnalyticsRange) {
  const { api } = useAuth();
  return useQuery({
    queryKey: analyticsKeys.overview(range),
    queryFn: () => api.get(`/api/v1/analytics/overview?range=${range}`, AnalyticsOverviewSchema),
    // Keep the previous range on screen while the new one loads.
    placeholderData: keepPreviousData,
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useMonitorMetrics(monitorId: string, range: AnalyticsRange) {
  const { api } = useAuth();
  return useQuery({
    queryKey: analyticsKeys.monitor(monitorId, range),
    queryFn: () =>
      api.get(
        `/api/v1/monitors/${encodeURIComponent(monitorId)}/metrics?range=${range}`,
        MonitorMetricsSchema,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}
