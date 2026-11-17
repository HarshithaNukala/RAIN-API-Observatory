import { z } from 'zod';
import { MonitorHeaderListSchema, MonitorHeaderSummarySchema } from './monitor-headers.js';
import { MAX_MONITOR_URL_LENGTH, findMonitorUrlIssue, normalizeMonitorUrl } from './monitor-url.js';

/**
 * Methods suitable for a recurring probe. DELETE, TRACE and CONNECT are deliberately excluded.
 * POST, PUT and PATCH can still have side effects on the target, so they should only be pointed
 * at endpoints the owner is authorised to call repeatedly.
 */
export const MONITOR_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH'] as const;
export const MonitorMethodSchema = z.enum(MONITOR_METHODS, 'Choose a supported HTTP method');
export type MonitorMethod = z.infer<typeof MonitorMethodSchema>;

const BODY_METHODS: ReadonlySet<MonitorMethod> = new Set(['POST', 'PUT', 'PATCH']);
export const methodAllowsBody = (method: MonitorMethod): boolean => BODY_METHODS.has(method);

/** Last observed health. "Paused" is not a status: it is `enabled = false`. */
export const MONITOR_STATUSES = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'DOWN'] as const;
export const MonitorStatusSchema = z.enum(MONITOR_STATUSES);
export type MonitorStatus = z.infer<typeof MonitorStatusSchema>;

/** Operational safety bounds, not subscription tiers. The per-user quota is server config. */
export const MONITOR_LIMITS = {
  nameMaxLength: 100,
  descriptionMaxLength: 500,
  urlMaxLength: MAX_MONITOR_URL_LENGTH,
  timeoutMs: { min: 1000, max: 30_000, default: 10_000 },
  latencyThresholdMs: { min: 1, max: 30_000, default: 2000 },
  checkIntervalSeconds: { min: 60, max: 86_400, default: 300 },
  expectedStatusCode: { min: 100, max: 599, default: 200 },
  requestBodyMaxBytes: 64 * 1024,
  bodyContentTypeMaxLength: 150,
  defaultBodyContentType: 'application/json',
  listPageSize: { max: 100, default: 25 },
  searchMaxLength: 100,
} as const;

const L = MONITOR_LIMITS;
const TOKEN = "[A-Za-z0-9!#$&^_.+'*%`|~-]+";
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(\\s*;\\s*${TOKEN}=(${TOKEN}|"[^"\\r\\n]*"))*$`);

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

const boundedInt = (label: string, unit: string, { min, max }: { min: number; max: number }) =>
  z
    .number(`${label} must be a number`)
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}${unit}`)
    .max(max, `${label} must be at most ${max}${unit}`);

export const MonitorNameSchema = z
  .string('Enter a name')
  .trim()
  .min(1, 'Enter a name')
  .max(L.nameMaxLength, `Name must be at most ${L.nameMaxLength} characters`);

export const MonitorDescriptionSchema = z
  .string()
  .trim()
  .max(L.descriptionMaxLength, `Description must be at most ${L.descriptionMaxLength} characters`)
  .nullish()
  .transform((v) => v || null);

export const MonitorUrlSchema = z
  .string('Enter a URL')
  .trim()
  .min(1, 'Enter a URL')
  .superRefine((value, ctx) => {
    const issue = findMonitorUrlIssue(value);
    if (issue) {
      // `params.code` travels to the API error body as the issue's machine-readable code.
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        ...(issue.code && { params: { code: issue.code } }),
      });
    }
  })
  .transform((value, ctx) => {
    try {
      return normalizeMonitorUrl(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid URL' });
      return z.NEVER;
    }
  });

export const MonitorRequestBodySchema = z
  .string()
  .refine(
    (v) => utf8Bytes(v) <= L.requestBodyMaxBytes,
    `Request body must be at most ${L.requestBodyMaxBytes / 1024} KB`,
  )
  .nullish()
  .transform((v) => v || null);

export const MonitorBodyContentTypeSchema = z
  .string()
  .trim()
  .max(
    L.bodyContentTypeMaxLength,
    `Content type must be at most ${L.bodyContentTypeMaxLength} characters`,
  )
  .refine((v) => v === '' || MEDIA_TYPE.test(v), 'Enter a media type, such as application/json')
  .nullish()
  .transform((v) => v || null);

const fields = {
  name: MonitorNameSchema,
  description: MonitorDescriptionSchema,
  url: MonitorUrlSchema,
  method: MonitorMethodSchema,
  expectedStatusCode: boundedInt('Expected status', '', L.expectedStatusCode),
  timeoutMs: boundedInt('Timeout', ' ms', L.timeoutMs),
  latencyThresholdMs: boundedInt('Latency threshold', ' ms', L.latencyThresholdMs),
  checkIntervalSeconds: boundedInt('Interval', ' seconds', L.checkIntervalSeconds),
  requestBody: MonitorRequestBodySchema,
  bodyContentType: MonitorBodyContentTypeSchema,
};

export interface MonitorRequestShape {
  method: MonitorMethod;
  timeoutMs: number;
  latencyThresholdMs: number;
  requestBody: string | null;
  bodyContentType: string | null;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * Rules that span several fields. Shared so the form, create and partial update (after merging
 * the patch into the stored monitor) all enforce exactly the same thing.
 */
export function findMonitorConfigIssues(config: MonitorRequestShape): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.requestBody && !methodAllowsBody(config.method)) {
    issues.push({
      path: 'requestBody',
      message: `${config.method} requests can't send a body. Remove it or use POST, PUT or PATCH`,
    });
  }
  if (config.bodyContentType && !config.requestBody) {
    issues.push({
      path: 'bodyContentType',
      message: 'A content type only applies when there is a request body',
    });
  }
  if (config.latencyThresholdMs > config.timeoutMs) {
    issues.push({
      path: 'latencyThresholdMs',
      message: 'Latency threshold must not be longer than the timeout',
    });
  }
  return issues;
}

/** A body with no declared type is sent as JSON, the overwhelmingly common case for APIs. */
export function resolveBodyContentType(body: string | null, contentType: string | null) {
  return body ? (contentType ?? L.defaultBodyContentType) : null;
}

export const CreateMonitorSchema = z
  .object({
    ...fields,
    method: fields.method.default('GET'),
    expectedStatusCode: fields.expectedStatusCode.default(L.expectedStatusCode.default),
    timeoutMs: fields.timeoutMs.default(L.timeoutMs.default),
    latencyThresholdMs: fields.latencyThresholdMs.default(L.latencyThresholdMs.default),
    checkIntervalSeconds: fields.checkIntervalSeconds.default(L.checkIntervalSeconds.default),
    headers: MonitorHeaderListSchema.default([]),
  })
  .strict()
  .superRefine((monitor, ctx) => {
    for (const issue of findMonitorConfigIssues(monitor)) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
export type CreateMonitor = z.infer<typeof CreateMonitorSchema>;
export type CreateMonitorInput = z.input<typeof CreateMonitorSchema>;

/**
 * Partial update of ordinary settings. Headers are intentionally not accepted here (the schema
 * is strict), so editing a monitor can never erase a stored credential by omission.
 * For `requestBody`: omitted = keep, null = remove, string = replace.
 *
 * Changing the URL to a different origin (scheme, host or port) while headers or a request body
 * are saved is refused with 409 MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED unless
 * `confirmOriginChange: true` is sent. With it, the saved headers, body and body content type are
 * removed in the same transaction, so credentials are never sent to a destination they weren't
 * entered for. A `requestBody` sent in the same request is the new body for the new destination.
 */
export const UpdateMonitorSchema = z
  .object({ ...fields, confirmOriginChange: z.boolean() })
  .partial()
  .strict()
  .refine(
    ({ confirmOriginChange: _confirm, ...changes }) => Object.keys(changes).length > 0,
    'Provide at least one field to update',
  );
export type UpdateMonitor = z.infer<typeof UpdateMonitorSchema>;
export type UpdateMonitorInput = z.input<typeof UpdateMonitorSchema>;

/** What an update did beyond the requested fields. Never says anything about secret contents. */
export const MonitorUpdateMetaSchema = z.object({
  originChanged: z.boolean(),
  /** True when saved headers and/or the saved request body were removed by an origin change. */
  savedConfigurationCleared: z.boolean(),
});
export type MonitorUpdateMeta = z.infer<typeof MonitorUpdateMetaSchema>;

const timestamp = z.iso.datetime({ offset: true });

/** List item. Never contains the request body or anything about header contents. */
export const MonitorSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  method: MonitorMethodSchema,
  expectedStatusCode: z.number().int(),
  timeoutMs: z.number().int(),
  latencyThresholdMs: z.number().int(),
  checkIntervalSeconds: z.number().int(),
  enabled: z.boolean(),
  currentStatus: MonitorStatusSchema,
  lastCheckedAt: timestamp.nullable(),
  nextCheckAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type MonitorSummary = z.infer<typeof MonitorSummarySchema>;

/**
 * Full configuration for the owner. The request body is returned so it can be edited; header
 * values are write-only and appear only as `{ name, configured: true }`.
 */
export const MonitorResponseSchema = MonitorSummarySchema.extend({
  requestBody: z.string().nullable(),
  bodyContentType: z.string().nullable(),
  headers: z.array(MonitorHeaderSummarySchema),
});
export type Monitor = z.infer<typeof MonitorResponseSchema>;

/** Body of `PATCH /api/v1/monitors/:id`: the updated monitor plus what the update did. */
export const MonitorUpdateResponseSchema = z.object({
  data: MonitorResponseSchema,
  meta: MonitorUpdateMetaSchema,
});
export type MonitorUpdateResponse = z.infer<typeof MonitorUpdateResponseSchema>;

export const MONITOR_STATE_FILTERS = ['all', 'enabled', 'paused'] as const;

export const MonitorListQuerySchema = z.object({
  search: z.string().trim().max(L.searchMaxLength).optional(),
  state: z.enum(MONITOR_STATE_FILTERS).default('all'),
  status: MonitorStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(L.listPageSize.max).default(L.listPageSize.default),
  cursor: z.string().max(300).optional(),
});
export type MonitorListQuery = z.infer<typeof MonitorListQuerySchema>;
export type MonitorListQueryInput = z.input<typeof MonitorListQuerySchema>;

export const MonitorListResponseSchema = z.object({
  items: z.array(MonitorSummarySchema),
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  /** Monitors matching the current filters, across all pages. */
  total: z.number().int().nonnegative(),
  quota: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }),
});
export type MonitorList = z.infer<typeof MonitorListResponseSchema>;
