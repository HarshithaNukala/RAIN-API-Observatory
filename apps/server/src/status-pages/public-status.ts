import { randomBytes } from 'node:crypto';
import {
  RESERVED_SLUGS,
  STATUS_PAGE_LIMITS,
  STATUS_PAGE_SLUG_PATTERN,
  type IncidentSeverity,
  type IncidentStatus,
  type MonitorStatus,
  type OverallStatus,
  type PublicIncident,
  type PublicServiceStatus,
} from '@rain/shared';

/**
 * Pure rules for the public status view. Everything public is generated here from a small set of
 * safe fields; internal names, incident titles, descriptions and timelines never pass through.
 */

/** A paused monitor is shown as PAUSED and left out of the overall status. */
export function publicServiceStatus(status: MonitorStatus, enabled: boolean): PublicServiceStatus {
  return enabled ? status : 'PAUSED';
}

/**
 * Overall status of a page, from its services:
 * - DOWN if any active (not paused) service is DOWN;
 * - DEGRADED if none is DOWN but at least one is DEGRADED;
 * - UNKNOWN if no active service has a known status (none checked yet, all paused, or none at all);
 * - HEALTHY otherwise.
 */
export function overallStatus(services: Array<{ status: PublicServiceStatus }>): OverallStatus {
  const active = services.filter((s) => s.status !== 'PAUSED');
  if (active.some((s) => s.status === 'DOWN')) return 'DOWN';
  if (active.some((s) => s.status === 'DEGRADED')) return 'DEGRADED';
  if (!active.some((s) => s.status === 'HEALTHY')) return 'UNKNOWN';
  return 'HEALTHY';
}

const PUBLIC_INCIDENT_STATUS = {
  OPEN: 'INVESTIGATING',
  ACKNOWLEDGED: 'IDENTIFIED',
  RESOLVED: 'RESOLVED',
} as const satisfies Record<IncidentStatus, PublicIncident['status']>;

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The public face of an incident. The internal title and description may contain internal monitor
 * names, error text or host names, so neither is used: the public title and summary are generated
 * from the service's public name, the status and the timestamps only.
 */
export function publicIncident(
  incident: {
    status: IncidentStatus;
    severity: IncidentSeverity;
    startedAt: Date;
    resolvedAt: Date | null;
  },
  serviceName: string,
  key: string,
): PublicIncident {
  const status = PUBLIC_INCIDENT_STATUS[incident.status];
  const summary =
    status === 'RESOLVED' && incident.resolvedAt
      ? `${serviceName} was unavailable or failing checks. Resolved after ${duration(incident.resolvedAt.getTime() - incident.startedAt.getTime())}.`
      : status === 'IDENTIFIED'
        ? `${serviceName} is unavailable or failing checks. The team is aware and working on it.`
        : `${serviceName} is unavailable or failing checks. We are investigating.`;
  return {
    key,
    title: `${serviceName} disruption`,
    serviceName,
    status,
    severity: incident.severity,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    summary,
  };
}

export interface DayCounts {
  /** Midnight UTC of the day, in ms. */
  dayMs: number;
  eligible: number;
  successful: number;
}

const DAY = 86_400_000;
const percent = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100_000) / 1000 : null;

/** First UTC day shown: the last `historyDays` days including today. */
export function historyStart(
  now: Date,
  historyDays: number = STATUS_PAGE_LIMITS.historyDays,
): Date {
  return new Date(Math.floor(now.getTime() / DAY) * DAY - (historyDays - 1) * DAY);
}

/**
 * Daily check-based availability for one service. Days without counted checks are null (shown as
 * "no data"), never 100% or 0%. The overall figure is computed from the summed counts.
 */
export function availabilityDays(
  rows: DayCounts[],
  now: Date,
  historyDays: number = STATUS_PAGE_LIMITS.historyDays,
): {
  days: Array<{ date: string; availabilityPercent: number | null }>;
  availabilityPercent: number | null;
} {
  const start = historyStart(now, historyDays).getTime();
  const byDay = new Map(rows.map((r) => [r.dayMs, r]));
  let eligible = 0;
  let successful = 0;
  const days = Array.from({ length: historyDays }, (_, i) => {
    const dayMs = start + i * DAY;
    const row = byDay.get(dayMs);
    if (row) {
      eligible += row.eligible;
      successful += row.successful;
    }
    return {
      date: new Date(dayMs).toISOString().slice(0, 10),
      availabilityPercent: row ? percent(row.successful, row.eligible) : null,
    };
  });
  return { days, availabilityPercent: percent(successful, eligible) };
}

/** "Acme API!" → "acme-api"; falls back to "status" for titles without usable characters. */
export function slugFromTitle(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base.length >= 3 && !(RESERVED_SLUGS as readonly string[]).includes(base)
    ? base
    : 'status';
}

/** A slug candidate with a short random suffix, for when the plain one is taken. */
export function slugWithSuffix(base: string): string {
  const candidate = `${base.slice(0, 55)}-${randomBytes(4).toString('hex')}`;
  if (!STATUS_PAGE_SLUG_PATTERN.test(candidate)) throw new Error('generated slug is invalid');
  return candidate;
}
