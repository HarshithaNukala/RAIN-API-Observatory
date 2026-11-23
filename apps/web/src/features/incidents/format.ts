import type { IncidentEventType, IncidentSeverity, IncidentStatus } from '@rain/shared';

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

export const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const EVENT_LABELS: Record<IncidentEventType, string> = {
  INCIDENT_CREATED: 'Incident opened',
  INCIDENT_ACKNOWLEDGED: 'Acknowledged',
  INCIDENT_RESOLVED: 'Resolved',
  INCIDENT_UPDATED: 'Updated',
};

/** "2h 5m", "3m 20s", "45s": how long an incident lasted (or has lasted so far). */
export function formatDuration(fromIso: string, toIso: string | null, now = Date.now()): string {
  const end = toIso ? Date.parse(toIso) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(fromIso)) / 1000));
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
