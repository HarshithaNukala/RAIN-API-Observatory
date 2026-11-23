import { z } from 'zod';
import { IncidentSeveritySchema, IncidentStatusSchema } from './incident.js';
import { MonitorHeaderUpsertSchema } from './monitor-headers.js';
import { findMonitorUrlIssue } from './monitor-url.js';

/**
 * Notification contracts. Incidents (not individual checks) trigger notifications: one delivery
 * per incident event per enabled channel, queued in a transactional outbox and sent by the
 * worker. External delivery is at-least-once.
 */

export const NOTIFICATION_EVENT_TYPES = ['INCIDENT_CREATED', 'INCIDENT_RESOLVED'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['EMAIL', 'WEBHOOK'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_ATTEMPT_OUTCOMES = [
  'SUCCESS',
  'TEMPORARY_FAILURE',
  'PERMANENT_FAILURE',
] as const;
export type NotificationAttemptOutcome = (typeof NOTIFICATION_ATTEMPT_OUTCOMES)[number];

export const NOTIFICATION_LIMITS = {
  webhookUrlMaxLength: 2048,
  errorMaxLength: 500,
  /** Default bounded retry policy: at most this many attempts per delivery. */
  maxAttempts: 8,
  pageSize: { default: 25, max: 100 },
} as const;

/** Webhook signature headers (see docs/notifications.md for verification). */
export const WEBHOOK_HEADERS = {
  event: 'x-rain-event',
  delivery: 'x-rain-delivery',
  timestamp: 'x-rain-timestamp',
  signature: 'x-rain-signature',
} as const;

const timestamp = z.iso.datetime({ offset: true });

/**
 * The event snapshot stored in the outbox and sent (as JSON) to webhooks. Safe by construction:
 * no monitor URL, headers, request bodies or credentials.
 */
export const NotificationPayloadSchema = z.object({
  /** The incident timeline event this notification is about. */
  eventId: z.uuid(),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  occurredAt: timestamp,
  incident: z.object({
    id: z.uuid(),
    title: z.string(),
    severity: IncidentSeveritySchema,
    status: IncidentStatusSchema,
    summary: z.string(),
    startedAt: timestamp,
    resolvedAt: timestamp.nullable(),
  }),
  monitor: z.object({ id: z.uuid(), name: z.string() }),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

/** The JSON body of a webhook request. */
export const WebhookBodySchema = NotificationPayloadSchema.extend({
  /** Unique per delivery; repeated on retries, so receivers can de-duplicate. */
  deliveryId: z.uuid(),
});
export type WebhookBody = z.infer<typeof WebhookBodySchema>;

// --- Settings -----------------------------------------------------------------------------------

/** Webhook URLs follow the same destination rules as monitors (http/https, ports 80/443, …). */
export const WebhookUrlSchema = z
  .string()
  .trim()
  .max(NOTIFICATION_LIMITS.webhookUrlMaxLength)
  .superRefine((url, ctx) => {
    const issue = findMonitorUrlIssue(url);
    if (issue) ctx.addIssue({ code: 'custom', message: issue.message });
  });

/** A webhook's optional authentication header: monitor header rules, plus RAIN's own headers. */
export const WebhookHeaderSchema = MonitorHeaderUpsertSchema.refine(
  (h) => !h.name.toLowerCase().startsWith('x-rain-') && h.name.toLowerCase() !== 'user-agent',
  {
    path: ['name'],
    message: "X-Rain-* and User-Agent headers are set by RAIN and can't be overridden",
  },
);

export const NotificationSettingsSchema = z.object({
  monitorId: z.uuid(),
  email: z.object({
    enabled: z.boolean(),
    /** Where emails go: the owner's account address. Null when the account has none. */
    address: z.string().nullable(),
    /** Whether this RAIN deployment has an email provider configured. */
    providerConfigured: z.boolean(),
  }),
  webhook: z
    .object({
      enabled: z.boolean(),
      url: z.string(),
      /** Name of the optional authentication header; its value is never returned. */
      headerName: z.string().nullable(),
      updatedAt: timestamp,
    })
    .nullable(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const UpdateNotificationSettingsSchema = z
  .strictObject({
    emailEnabled: z.boolean().optional(),
    /** `null` removes the webhook (and its secret and header). */
    webhook: z
      .strictObject({
        enabled: z.boolean(),
        url: WebhookUrlSchema,
        /** Omit to keep the stored header, `null` to remove it. */
        header: WebhookHeaderSchema.nullable().optional(),
        /** Generate a new signing secret (always done when a webhook is first configured). */
        rotateSecret: z.boolean().optional(),
      })
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateNotificationSettings = z.infer<typeof UpdateNotificationSettingsSchema>;
export type UpdateNotificationSettingsInput = z.input<typeof UpdateNotificationSettingsSchema>;

export const NotificationSettingsUpdateResponseSchema = z.object({
  settings: NotificationSettingsSchema,
  /** Shown exactly once, when a webhook is created or its secret rotated. Store it now. */
  signingSecret: z.string().nullable(),
});
export type NotificationSettingsUpdateResponse = z.infer<
  typeof NotificationSettingsUpdateResponseSchema
>;

// --- Delivery history ---------------------------------------------------------------------------

export const NotificationDeliverySchema = z.object({
  id: z.uuid(),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  channel: z.enum(NOTIFICATION_CHANNELS),
  status: z.enum(NOTIFICATION_STATUSES),
  /** Safe description of where it goes: a masked email address or the webhook host. */
  destination: z.string(),
  monitor: z.object({ id: z.uuid(), name: z.string() }),
  incident: z.object({ id: z.uuid(), title: z.string() }),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  createdAt: timestamp,
  nextAttemptAt: timestamp.nullable(),
  lastAttemptedAt: timestamp.nullable(),
  deliveredAt: timestamp.nullable(),
  /** Sanitised; never a secret, raw provider response or stack trace. */
  lastError: z.string().nullable(),
});
export type NotificationDelivery = z.infer<typeof NotificationDeliverySchema>;

export const NotificationAttemptSchema = z.object({
  attemptNumber: z.number().int(),
  startedAt: timestamp,
  finishedAt: timestamp,
  outcome: z.enum(NOTIFICATION_ATTEMPT_OUTCOMES),
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type NotificationAttempt = z.infer<typeof NotificationAttemptSchema>;

export const NotificationDeliveryDetailSchema = NotificationDeliverySchema.extend({
  attemptHistory: z.array(NotificationAttemptSchema),
});
export type NotificationDeliveryDetail = z.infer<typeof NotificationDeliveryDetailSchema>;

export const NotificationListQuerySchema = z.object({
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  channel: z.enum(NOTIFICATION_CHANNELS).optional(),
  monitorId: z.uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATION_LIMITS.pageSize.max)
    .default(NOTIFICATION_LIMITS.pageSize.default),
  cursor: z.string().max(300).optional(),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

export const NotificationListResponseSchema = z.object({
  items: z.array(NotificationDeliverySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
});
export type NotificationList = z.infer<typeof NotificationListResponseSchema>;
