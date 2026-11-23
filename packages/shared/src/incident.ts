import { z } from 'zod';
import { MonitorStatusSchema } from './monitor.js';

/**
 * Incident contracts, shared by the database constraints, the worker, the API and the web app.
 *
 * An incident is opened automatically when a monitor reaches DOWN and resolved automatically after
 * the recovery threshold of consecutive passing checks. The owner can acknowledge it and edit its
 * title, description and severity; the timeline of events is append-only.
 */

export const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);

/** Not RESOLVED. A monitor has at most one active incident (enforced by a partial unique index). */
export const ACTIVE_INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED'] as const;

export const INCIDENT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const IncidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);

/**
 * Severity of an automatically detected outage. A confirmed DOWN is serious but RAIN can't know
 * the business impact, so it starts at HIGH; the owner can raise it to CRITICAL or lower it.
 */
export const DEFAULT_INCIDENT_SEVERITY: IncidentSeverity = 'HIGH';

export const INCIDENT_EVENT_TYPES = [
  'INCIDENT_CREATED',
  'INCIDENT_ACKNOWLEDGED',
  'INCIDENT_RESOLVED',
  'INCIDENT_UPDATED',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

export const INCIDENT_LIMITS = {
  titleMaxLength: 200,
  descriptionMaxLength: 2000,
  eventDescriptionMaxLength: 500,
  pageSize: { default: 20, max: 100 },
  eventPageSize: { default: 100, max: 200 },
} as const;

const timestamp = z.iso.datetime({ offset: true });

/** The monitor an incident belongs to, as shown with the incident: no URL, no secrets. */
export const IncidentMonitorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  currentStatus: MonitorStatusSchema,
  enabled: z.boolean(),
});

export const IncidentSchema = z.object({
  id: z.uuid(),
  monitor: IncidentMonitorSchema,
  title: z.string(),
  description: z.string().nullable(),
  severity: IncidentSeveritySchema,
  status: IncidentStatusSchema,
  startedAt: timestamp,
  acknowledgedAt: timestamp.nullable(),
  /** The user who acknowledged it (always the owner today). */
  acknowledgedBy: z.uuid().nullable(),
  resolvedAt: timestamp.nullable(),
  /** The check that took the monitor DOWN. */
  triggerCheckId: z.uuid().nullable(),
  /** The check that completed the recovery. */
  resolvedByCheckId: z.uuid().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Incident = z.infer<typeof IncidentSchema>;

export const IncidentEventSchema = z.object({
  id: z.uuid(),
  type: z.enum(INCIDENT_EVENT_TYPES),
  occurredAt: timestamp,
  /** SYSTEM for events the monitoring engine records, USER for the owner's actions. */
  actor: z.enum(['SYSTEM', 'USER']),
  actorId: z.uuid().nullable(),
  description: z.string(),
  checkId: z.uuid().nullable(),
});
export type IncidentEvent = z.infer<typeof IncidentEventSchema>;

/** `ACTIVE` means OPEN or ACKNOWLEDGED. */
export const INCIDENT_STATUS_FILTERS = [...INCIDENT_STATUSES, 'ACTIVE'] as const;
export type IncidentStatusFilter = (typeof INCIDENT_STATUS_FILTERS)[number];

export const IncidentListQuerySchema = z.object({
  status: z.enum(INCIDENT_STATUS_FILTERS).optional(),
  severity: IncidentSeveritySchema.optional(),
  monitorId: z.uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(INCIDENT_LIMITS.pageSize.max)
    .default(INCIDENT_LIMITS.pageSize.default),
  cursor: z.string().max(300).optional(),
});
export type IncidentListQuery = z.infer<typeof IncidentListQuerySchema>;
export type IncidentListQueryInput = z.input<typeof IncidentListQuerySchema>;

export const IncidentListResponseSchema = z.object({
  items: z.array(IncidentSchema),
  nextCursor: z.string().nullable(),
  /** Incidents matching the filters, across all pages. */
  total: z.number().int(),
});
export type IncidentList = z.infer<typeof IncidentListResponseSchema>;

export const IncidentCountsQuerySchema = z.object({ monitorId: z.uuid().optional() });

export const IncidentCountsSchema = z.object({
  total: z.number().int(),
  open: z.number().int(),
  acknowledged: z.number().int(),
  resolved: z.number().int(),
});
export type IncidentCounts = z.infer<typeof IncidentCountsSchema>;

export const IncidentEventListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(INCIDENT_LIMITS.eventPageSize.max)
    .default(INCIDENT_LIMITS.eventPageSize.default),
  cursor: z.string().max(300).optional(),
});
export type IncidentEventListQuery = z.infer<typeof IncidentEventListQuerySchema>;

/** Oldest first: a timeline reads top to bottom. */
export const IncidentEventListResponseSchema = z.object({
  items: z.array(IncidentEventSchema),
  nextCursor: z.string().nullable(),
});
export type IncidentEventList = z.infer<typeof IncidentEventListResponseSchema>;

const title = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(
    INCIDENT_LIMITS.titleMaxLength,
    `Title must be at most ${INCIDENT_LIMITS.titleMaxLength} characters`,
  );
const description = z
  .string()
  .trim()
  .max(
    INCIDENT_LIMITS.descriptionMaxLength,
    `Description must be at most ${INCIDENT_LIMITS.descriptionMaxLength} characters`,
  )
  .transform((v) => (v === '' ? null : v));

/** The metadata an owner may change. Status changes go through acknowledge (or the engine). */
export const UpdateIncidentSchema = z
  .strictObject({
    title: title.optional(),
    description: description.nullable().optional(),
    severity: IncidentSeveritySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateIncident = z.infer<typeof UpdateIncidentSchema>;
export type UpdateIncidentInput = z.input<typeof UpdateIncidentSchema>;
