import { z } from 'zod';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'MONITOR_NOT_FOUND',
  'MONITOR_LIMIT_REACHED',
  'MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED',
  'CONFLICT',
  // Manual checks (POST /monitors/:id/check).
  'MONITOR_PAUSED',
  'MONITOR_CONFIGURATION_INVALID',
  'CHECK_ALREADY_QUEUED',
  'CHECK_COOLDOWN',
  // Incidents.
  'INCIDENT_NOT_FOUND',
  'INCIDENT_ALREADY_ACKNOWLEDGED',
  'INCIDENT_ALREADY_RESOLVED',
  // Notifications.
  'NOTIFICATION_NOT_FOUND',
  'NOTIFICATION_NOT_RETRYABLE',
  // Status pages.
  'STATUS_PAGE_NOT_FOUND',
  'STATUS_PAGE_SLUG_TAKEN',
  'STATUS_PAGE_LIMIT_REACHED',
  'STATUS_PAGE_MONITOR_EXISTS',
  'STATUS_PAGE_MONITOR_LIMIT_REACHED',
  // A 400 whose only problem is a URL with a non-standard port. Details carry the field issue.
  'UNSUPPORTED_PORT',
  'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

/**
 * One validation problem, addressed to a request field such as `url`. `code` is present when the
 * problem has a machine-readable identity (for example `UNSUPPORTED_PORT`).
 */
export const ApiFieldIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export type ApiFieldIssue = z.infer<typeof ApiFieldIssueSchema>;
