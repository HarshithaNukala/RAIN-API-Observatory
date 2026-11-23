import { z } from 'zod';
import { IncidentSeveritySchema } from './incident.js';
import { MonitorStatusSchema } from './monitor.js';

/**
 * Public status pages. An owner publishes a page that shows selected monitors under public
 * display names. The public view is a separate, deliberately small contract: no database IDs,
 * no monitor URLs or names, no internal incident text.
 */

export const STATUS_PAGE_LIMITS = {
  titleMaxLength: 120,
  descriptionMaxLength: 1000,
  displayNameMaxLength: 100,
  slug: { min: 3, max: 64 },
  pagesPerOwner: 10,
  monitorsPerPage: 50,
  /** Public history window and incident list bound. */
  historyDays: 30,
  publicIncidents: 20,
} as const;

/** Lowercase letters, digits and single hyphens; starts and ends with a letter or digit. */
export const STATUS_PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,62}[a-z0-9]$/;

/** Paths of the web app itself; never usable as slugs, to keep public URLs unambiguous. */
export const RESERVED_SLUGS = ['app', 'api', 'admin', 'login', 'status', 'www', 'new'] as const;

// Control characters (other than line breaks and tabs in descriptions) are never stored, nor are
// bidirectional overrides/isolates (U+202A–U+202E, U+2066–U+2069), which can make public text
// display differently from what it is ("Trojan Source"-style spoofing on a public page).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

export const StatusPageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(
    STATUS_PAGE_LIMITS.slug.min,
    `The address must be at least ${STATUS_PAGE_LIMITS.slug.min} characters`,
  )
  .max(
    STATUS_PAGE_LIMITS.slug.max,
    `The address can be at most ${STATUS_PAGE_LIMITS.slug.max} characters`,
  )
  .regex(
    STATUS_PAGE_SLUG_PATTERN,
    'Use lowercase letters, numbers and single hyphens (e.g. acme-api)',
  )
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'This address is reserved');

const title = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(
    STATUS_PAGE_LIMITS.titleMaxLength,
    `Title must be at most ${STATUS_PAGE_LIMITS.titleMaxLength} characters`,
  )
  .refine((v) => !CONTROL_OR_NEWLINE.test(v), 'Title must be a single line of text');

/** Plain text only: rendered as text (never as HTML) on the public page. */
const description = z
  .string()
  .trim()
  .max(
    STATUS_PAGE_LIMITS.descriptionMaxLength,
    `Description must be at most ${STATUS_PAGE_LIMITS.descriptionMaxLength} characters`,
  )
  .refine((v) => !CONTROL.test(v), 'Description contains unsupported characters')
  .transform((v) => (v === '' ? null : v));

export const StatusPageDisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a public name')
  .max(
    STATUS_PAGE_LIMITS.displayNameMaxLength,
    `Public names can be at most ${STATUS_PAGE_LIMITS.displayNameMaxLength} characters`,
  )
  .refine((v) => !CONTROL_OR_NEWLINE.test(v), 'Public name must be a single line of text');

export const CreateStatusPageSchema = z.strictObject({
  title,
  description: description.nullable().optional(),
  /** Generated from the title when omitted. */
  slug: StatusPageSlugSchema.optional(),
});
export type CreateStatusPage = z.infer<typeof CreateStatusPageSchema>;
export type CreateStatusPageInput = z.input<typeof CreateStatusPageSchema>;

export const UpdateStatusPageSchema = z
  .strictObject({
    title: title.optional(),
    description: description.nullable().optional(),
    slug: StatusPageSlugSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateStatusPage = z.infer<typeof UpdateStatusPageSchema>;
export type UpdateStatusPageInput = z.input<typeof UpdateStatusPageSchema>;

export const AddStatusPageMonitorSchema = z.strictObject({
  monitorId: z.uuid(),
  /** Defaults to the monitor's own name; the owner should pick a public-friendly one. */
  displayName: StatusPageDisplayNameSchema.optional(),
});
export type AddStatusPageMonitor = z.infer<typeof AddStatusPageMonitorSchema>;

export const UpdateStatusPageMonitorSchema = z.strictObject({
  displayName: StatusPageDisplayNameSchema,
});

/** The new order: exactly the page's current monitor IDs, each once. */
export const ReorderStatusPageMonitorsSchema = z.strictObject({
  monitorIds: z
    .array(z.uuid())
    .max(STATUS_PAGE_LIMITS.monitorsPerPage)
    .refine(
      (ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length,
      'Each monitor must appear once',
    ),
});

const timestamp = z.iso.datetime({ offset: true });

/** Owner-facing configuration. */
export const StatusPageMonitorSchema = z.object({
  monitorId: z.uuid(),
  /** The monitor's private name, shown only to the owner. */
  monitorName: z.string(),
  displayName: z.string(),
  position: z.number().int(),
  currentStatus: MonitorStatusSchema,
  enabled: z.boolean(),
});
export type StatusPageMonitor = z.infer<typeof StatusPageMonitorSchema>;

export const StatusPageSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  slug: z.string(),
  published: z.boolean(),
  publishedAt: timestamp.nullable(),
  monitors: z.array(StatusPageMonitorSchema),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type StatusPage = z.infer<typeof StatusPageSchema>;

export const StatusPageSummarySchema = StatusPageSchema.omit({ monitors: true }).extend({
  monitorCount: z.number().int(),
});
export type StatusPageSummary = z.infer<typeof StatusPageSummarySchema>;

export const StatusPageListSchema = z.object({
  items: z.array(StatusPageSummarySchema),
  quota: z.object({ used: z.number().int(), limit: z.number().int() }),
});
export type StatusPageList = z.infer<typeof StatusPageListSchema>;

// --- Public view (no auth) -------------------------------------------------------------------------

/** A service's health as shown publicly: monitor health, or PAUSED for paused monitors. */
export const PUBLIC_SERVICE_STATUSES = [
  'HEALTHY',
  'DEGRADED',
  'DOWN',
  'UNKNOWN',
  'PAUSED',
] as const;
export type PublicServiceStatus = (typeof PUBLIC_SERVICE_STATUSES)[number];

export const OVERALL_STATUSES = ['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];

/** One day of check-based availability; null when nothing was recorded that day. */
export const PublicAvailabilityDaySchema = z.object({
  date: z.iso.date(),
  availabilityPercent: z.number().nullable(),
});

export const PublicServiceSchema = z.object({
  /** Position on the page (stable while the configuration is unchanged); never a database ID. */
  key: z.string(),
  name: z.string(),
  status: z.enum(PUBLIC_SERVICE_STATUSES),
  lastCheckedAt: timestamp.nullable(),
  /** Check-based availability over the history window; null when there is no data. */
  availabilityPercent: z.number().nullable(),
  days: z.array(PublicAvailabilityDaySchema),
});
export type PublicService = z.infer<typeof PublicServiceSchema>;

export const PUBLIC_INCIDENT_STATUSES = ['INVESTIGATING', 'IDENTIFIED', 'RESOLVED'] as const;

export const PublicIncidentSchema = z.object({
  key: z.string(),
  /** Generated from the service's public name; internal incident titles are never shown. */
  title: z.string(),
  serviceName: z.string(),
  status: z.enum(PUBLIC_INCIDENT_STATUSES),
  severity: IncidentSeveritySchema,
  startedAt: timestamp,
  resolvedAt: timestamp.nullable(),
  /** Generated public summary; internal descriptions and timelines are never shown. */
  summary: z.string(),
});
export type PublicIncident = z.infer<typeof PublicIncidentSchema>;

export const PublicStatusPageSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  overallStatus: z.enum(OVERALL_STATUSES),
  services: z.array(PublicServiceSchema),
  incidents: z.array(PublicIncidentSchema),
  historyDays: z.number().int(),
  /** When this view was generated. */
  generatedAt: timestamp,
});
export type PublicStatusPage = z.infer<typeof PublicStatusPageSchema>;
