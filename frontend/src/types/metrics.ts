export type TimeWindow = '1h' | '6h' | '24h' | '7d' | '30d';

export interface DashboardSummaryResponse {
  window: TimeWindow;
  totalApis: number;
  enabledApis: number;
  pausedApis: number;
  healthyApis: number;
  degradedApis: number;
  downApis: number;
  unknownApis: number;
  totalChecks: number;
  successfulChecks: number;
  failedChecks: number;
  overallCheckBasedUptimePercentage: number | null;
  overallAverageResponseLatencyMs: number | null;
  overallP95ResponseLatencyMs: number | null;
}

export interface ApiMetricsResponse {
  window: TimeWindow;
  totalChecks: number;
  successfulChecks: number;
  failedChecks: number;
  uptimePercentage: number | null;
  failureRate: number | null;
  averageResponseLatencyMs: number | null;
  p95ResponseLatencyMs: number | null;
  currentStatus: string;
  lastCheckedAt: string | null;
  lastSuccessfulAt: string | null;
  lastFailedAt: string | null;
}

export interface LatencySeriesPoint {
  timestamp: string;
  averageResponseLatencyMs: number;
  p95ResponseLatencyMs: number;
  minResponseLatencyMs: number;
  maxResponseLatencyMs: number;
}

export interface SuccessFailureSeriesPoint {
  timestamp: string;
  successful: number;
  failed: number;
}
