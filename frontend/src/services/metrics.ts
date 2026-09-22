import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import type {
  ApiMetricsResponse,
  DashboardSummaryResponse,
  LatencySeriesPoint,
  SuccessFailureSeriesPoint,
  TimeWindow,
} from '../types/metrics';

const API_BASE_URL = 'http://localhost:8080/api';

export const fetchDashboardSummary = async (window: TimeWindow): Promise<DashboardSummaryResponse> => {
  const response = await axios.get(`${API_BASE_URL}/dashboard/summary`, { params: { window } });
  return response.data;
};

export const fetchApiMetrics = async (id: number, window: TimeWindow): Promise<ApiMetricsResponse> => {
  const response = await axios.get(`${API_BASE_URL}/services/${id}/metrics`, { params: { window } });
  return response.data;
};

export const fetchLatencySeries = async (id: number, window: TimeWindow): Promise<LatencySeriesPoint[]> => {
  const response = await axios.get(`${API_BASE_URL}/services/${id}/metrics/latency`, { params: { window } });
  return response.data;
};

export const fetchSuccessFailureSeries = async (id: number, window: TimeWindow): Promise<SuccessFailureSeriesPoint[]> => {
  const response = await axios.get(`${API_BASE_URL}/services/${id}/metrics/success-failure`, { params: { window } });
  return response.data;
};

// React Query Hooks
export const useDashboardSummary = (window: TimeWindow) => {
  return useQuery({
    queryKey: ['dashboardSummary', window],
    queryFn: () => fetchDashboardSummary(window),
    refetchInterval: 15000, // Refresh every 15s
  });
};

export const useApiMetrics = (id: number, window: TimeWindow) => {
  return useQuery({
    queryKey: ['apiMetrics', id, window],
    queryFn: () => fetchApiMetrics(id, window),
    refetchInterval: 15000,
  });
};

export const useLatencySeries = (id: number, window: TimeWindow) => {
  return useQuery({
    queryKey: ['latencySeries', id, window],
    queryFn: () => fetchLatencySeries(id, window),
    refetchInterval: 15000,
  });
};

export const useSuccessFailureSeries = (id: number, window: TimeWindow) => {
  return useQuery({
    queryKey: ['successFailureSeries', id, window],
    queryFn: () => fetchSuccessFailureSeries(id, window),
    refetchInterval: 15000,
  });
};
