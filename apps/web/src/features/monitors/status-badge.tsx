import type { MonitorStatus } from '@rain/shared';
import { Pause } from 'lucide-react';
import { Badge } from '@/components/ui/misc';
import { statusLabel } from './format';

const STYLE = {
  UNKNOWN: { tone: 'neutral', dot: 'bg-muted-foreground' },
  HEALTHY: { tone: 'success', dot: 'bg-success' },
  DEGRADED: { tone: 'warning', dot: 'bg-warning' },
  DOWN: { tone: 'danger', dot: 'bg-destructive' },
} as const;

/** The stored health status, exactly as last recorded. UNKNOWN until a real check has run. */
export function StatusBadge({ status }: { status: MonitorStatus }) {
  const { tone, dot } = STYLE[status];
  return (
    <Badge tone={tone}>
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
      {statusLabel(status)}
    </Badge>
  );
}

/** "Paused" is not a health status: it is shown from `enabled = false`, next to the stored one. */
export function PausedBadge() {
  return (
    <Badge tone="neutral">
      <Pause className="size-3" aria-hidden />
      Paused
    </Badge>
  );
}

export function MonitorStateBadges({
  status,
  enabled,
}: {
  status: MonitorStatus;
  enabled: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {!enabled && <PausedBadge />}
      <StatusBadge status={status} />
    </span>
  );
}
