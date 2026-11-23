import type { IncidentSeverity, IncidentStatus } from '@rain/shared';
import { Badge } from '@/components/ui/misc';
import { INCIDENT_STATUS_LABELS, SEVERITY_LABELS } from './format';

const STATUS_TONE = { OPEN: 'danger', ACKNOWLEDGED: 'warning', RESOLVED: 'success' } as const;
const SEVERITY_TONE = {
  CRITICAL: 'danger',
  HIGH: 'warning',
  MEDIUM: 'info',
  LOW: 'neutral',
} as const;

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{INCIDENT_STATUS_LABELS[status]}</Badge>;
}

export function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABELS[severity]}</Badge>;
}
