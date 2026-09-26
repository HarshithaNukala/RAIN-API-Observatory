export type IncidentStatus = 'OPEN' | 'RESOLVED';

export interface IncidentDto {
  id: number;
  apiServiceId: number;
  status: IncidentStatus;
  startedAt: string;
  resolvedAt: string | null;
  failureCount: number;
  latestErrorType: string | null;
  latestErrorMessage: string | null;
  latestHttpStatus: number | null;
  latestLatencyMs: number | null;
}
