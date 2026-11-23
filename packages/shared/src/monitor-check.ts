import { z } from 'zod';

/**
 * Vocabulary for recorded health checks, shared by the database constraints, the health logic,
 * the worker and the API.
 *
 * - `SUCCESS`: the expected status code arrived within the latency threshold.
 * - `DEGRADED`: the expected status code arrived, but slower than the latency threshold.
 * - `FAILURE`: anything else (wrong status code, or no HTTP response at all).
 */
export const MONITOR_CHECK_OUTCOMES = ['SUCCESS', 'DEGRADED', 'FAILURE'] as const;
export type MonitorCheckOutcome = (typeof MONITOR_CHECK_OUTCOMES)[number];

/** Why a check failed when no HTTP response was received. Latency is NULL for all of these. */
export const NO_RESPONSE_REASONS = [
  'TIMEOUT',
  'DNS_ERROR',
  'CONNECTION_ERROR',
  'TLS_ERROR',
  'BLOCKED_DESTINATION',
  'REQUEST_ERROR',
  /** RAIN refused to send the request (e.g. mutating method without permission). */
  'CONFIGURATION_ERROR',
] as const;
export type NoResponseReason = (typeof NO_RESPONSE_REASONS)[number];

/** Every failure reason: a received-but-wrong status, or one of the no-response reasons. */
export const CHECK_FAILURE_REASONS = ['UNEXPECTED_STATUS', ...NO_RESPONSE_REASONS] as const;
export type CheckFailureReason = (typeof CHECK_FAILURE_REASONS)[number];

/**
 * Failures caused by RAIN's own rules, not by the monitored API: the destination was refused by
 * the SSRF guard, or the monitor's configuration prevented sending. They are recorded in history
 * but never change the monitor's health or counters.
 */
export const HEALTH_NEUTRAL_REASONS: ReadonlySet<CheckFailureReason> = new Set([
  'BLOCKED_DESTINATION',
  'CONFIGURATION_ERROR',
]);

/** What started a check. */
export const MONITOR_CHECK_SOURCES = ['SCHEDULED', 'MANUAL'] as const;
export type MonitorCheckSource = (typeof MONITOR_CHECK_SOURCES)[number];

/** Consecutive results needed before the health status changes. */
export const HEALTH_THRESHOLDS = {
  /** Consecutive failures that mark a monitor DOWN. */
  failure: 2,
  /** Consecutive passing checks that bring a DOWN monitor back up. */
  recovery: 2,
} as const;

/** Upper bound for a stored error message; the executor must also sanitise its content. */
export const CHECK_ERROR_MESSAGE_MAX_LENGTH = 500;

/** Minimum time between two manual checks of one monitor. */
export const MANUAL_CHECK_COOLDOWN_MS = 10_000;

const timestamp = z.iso.datetime({ offset: true });

/** One check as the API returns it: no secrets, no request content, no connection details. */
export const MonitorCheckSchema = z.object({
  id: z.uuid(),
  checkedAt: timestamp,
  source: z.enum(MONITOR_CHECK_SOURCES),
  outcome: z.enum(MONITOR_CHECK_OUTCOMES),
  statusCode: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  failureReason: z.enum(CHECK_FAILURE_REASONS).nullable(),
  errorMessage: z.string().nullable(),
});
export type MonitorCheck = z.infer<typeof MonitorCheckSchema>;

export const MONITOR_CHECK_PAGE_SIZE = { max: 100, default: 25 } as const;

export const MonitorCheckListQuerySchema = z.object({
  source: z.enum(MONITOR_CHECK_SOURCES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MONITOR_CHECK_PAGE_SIZE.max)
    .default(MONITOR_CHECK_PAGE_SIZE.default),
  cursor: z.string().max(300).optional(),
});
export type MonitorCheckListQuery = z.infer<typeof MonitorCheckListQuerySchema>;
export type MonitorCheckListQueryInput = z.input<typeof MonitorCheckListQuerySchema>;

export const MonitorCheckListResponseSchema = z.object({
  items: z.array(MonitorCheckSchema),
  nextCursor: z.string().nullable(),
});
export type MonitorCheckList = z.infer<typeof MonitorCheckListResponseSchema>;

/** Response to `POST /api/v1/monitors/:id/check`. */
export const ManualCheckQueuedSchema = z.object({
  monitorId: z.uuid(),
  status: z.literal('QUEUED'),
  queuedAt: timestamp,
});
export type ManualCheckQueued = z.infer<typeof ManualCheckQueuedSchema>;
