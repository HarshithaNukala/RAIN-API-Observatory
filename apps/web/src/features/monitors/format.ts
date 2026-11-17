import { MONITOR_LIMITS, type MonitorStatus } from '@rain/shared';

export const STATUS_LABELS: Record<MonitorStatus, string> = {
  UNKNOWN: 'Unknown',
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
};
export const statusLabel = (status: MonitorStatus) => STATUS_LABELS[status];

export const ORIGIN_CHANGE_WARNING =
  'Changing this destination will remove saved authentication headers and the request body. You will need to enter them again for the new destination.';

export const INTERVAL_OPTIONS = [
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 1800, label: '30 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 6 * 3600, label: '6 hours' },
  { seconds: 12 * 3600, label: '12 hours' },
  { seconds: 24 * 3600, label: '24 hours' },
] as const;

export function formatInterval(seconds: number): string {
  const preset = INTERVAL_OPTIONS.find((o) => o.seconds === seconds);
  if (preset) return preset.label;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

/** "3 minutes ago", "in 2 hours"; falls back to the date for anything over a week away. */
export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds <= 0 ? 'just now' : 'in a few seconds';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return formatDateTime(iso);
}

const utf8 = new TextEncoder();
export const byteLength = (value: string) => utf8.encode(value).length;

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export const REQUEST_BODY_MAX_BYTES = MONITOR_LIMITS.requestBodyMaxBytes;
