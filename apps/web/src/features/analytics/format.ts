import type { AnalyticsRange } from '@rain/shared';

export const NO_DATA = 'No data';

/**
 * Availability as a percentage with two decimals, rounded DOWN so that a window with any failure
 * never shows "100%". Null (no eligible checks) is "No data", never 0%.
 */
export function formatAvailability(value: number | null): string {
  if (value === null) return NO_DATA;
  const floored = Math.floor(value * 100) / 100;
  return `${floored.toFixed(floored === 100 || floored === 0 ? 0 : 2)}%`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return NO_DATA;
  return `${(Math.round(value * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

/** "87 ms", "1.24 s". The API always reports milliseconds. */
export function formatLatency(ms: number | null): string {
  if (ms === null) return NO_DATA;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** A duration in ms as "45s", "12m 30s", "3h 5m", "2d 4h". */
export function formatDurationMs(ms: number | null): string {
  if (ms === null) return NO_DATA;
  const seconds = Math.round(ms / 1000);
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayHourFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
});
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Short axis label for a bucket start, in the viewer's time zone. */
export function bucketTick(iso: string, range: AnalyticsRange): string {
  const d = new Date(iso);
  if (range === '24h') return hourFormat.format(d);
  if (range === '7d') return dayHourFormat.format(d);
  return dayFormat.format(d);
}

/** "Nov 19, 2026, 9:00 AM – 10:00 AM" for tooltips and tables. */
export function bucketLabel(startIso: string, endIso: string): string {
  return `${fullFormat.format(new Date(startIso))} – ${hourFormat.format(new Date(endIso))}`;
}
