export interface Anomaly {
  healthCheckId: number;
  checkedAt: string;
  latencyMs: number;
  baselineAvgMs: number;
  baselineStdDevMs: number;
}

export interface ErrorTypeBreakdown {
  errorType: string;
  count: number;
  percentage: number;
}

export interface ServiceIntelligenceResponse {
  reliabilityScore: number | null;
  scoreTrend: 'IMPROVING' | 'STABLE' | 'DECLINING' | null;
  totalAnomalies: number;
  anomalies: Anomaly[];
  topErrorTypes: ErrorTypeBreakdown[];
  avgRecoveryTimeMs: number | null;
  rootCauseHints: string[];
}
