import { useQuery } from '@tanstack/react-query';
import type {
  ApiMetricsResponse,
  DashboardSummaryResponse,
  LatencySeriesPoint,
  SuccessFailureSeriesPoint,
  TimeWindow,
} from '../types/metrics';

const API_BASE_URL = '/api';

export const fetchDashboardSummary = async (window: TimeWindow): Promise<DashboardSummaryResponse> => {
  const response = await fetch(`${API_BASE_URL}/dashboard/summary?window=${window}`);
  if (!response.ok) throw new Error('Failed to fetch dashboard summary');
  return response.json();
};

export const fetchApiMetrics = async (id: number, window: TimeWindow): Promise<ApiMetricsResponse> => {
  const response = await fetch(`${API_BASE_URL}/services/${id}/metrics?window=${window}`);
  if (!response.ok) throw new Error('Failed to fetch api metrics');
  return response.json();
};

export const fetchLatencySeries = async (id: number, window: TimeWindow): Promise<LatencySeriesPoint[]> => {
  const response = await fetch(`${API_BASE_URL}/services/${id}/metrics/latency?window=${window}`);
  if (!response.ok) throw new Error('Failed to fetch latency series');
  return response.json();
};

export const fetchSuccessFailureSeries = async (id: number, window: TimeWindow): Promise<SuccessFailureSeriesPoint[]> => {
  const response = await fetch(`${API_BASE_URL}/services/${id}/metrics/success-failure?window=${window}`);
  if (!response.ok) throw new Error('Failed to fetch success failure series');
  return response.json();
};

// React Query Hooks
export const useDashboardSummary = (window: TimeWindow) => {
  return useQuery({
    queryKey: ['dashboardSummary', window],
    queryFn: () => fetchDashboardSummary(window),
    refetchInterval: 30000, // Refresh every 15s
  });
};

export const useApiMetrics = (id: number, window: TimeWindow) => {
  return useQuery({
    queryKey: ['apiMetrics', id, window],
    queryFn: () => fetchApiMetrics(id, window),
    refetchInterval: 30000,
  });
};

export const useLatencySeries = (id: number, window: TimeWindow) => {
  return useQuery({
    queryKey: ['latencySeries', id, window],
    queryFn: () => fetchLatencySeries(id, window),
    refetchInterval: 30000,
  });
};

export const useSuccessFailureSeries = (id: number, window: TimeWindow) => {
  return useQuery({
    queryKey: ['successFailureSeries', id, window],
    queryFn: () => fetchSuccessFailureSeries(id, window),
    refetchInterval: 30000,
  });
};
