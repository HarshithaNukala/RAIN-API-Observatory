import { z } from 'zod';

export const HEADER_LIMITS = {
  maxCount: 20,
  maxNameLength: 100,
  maxValueLength: 4096,
  /**
   * Combined UTF-8 size of all of a monitor's header names and values: checked per request and,
   * on the server, across the headers already stored plus the requested changes.
   */
  maxAggregateBytes: 32_768,
} as const;

const utf8 = new TextEncoder();

/** Bytes one header contributes to `HEADER_LIMITS.maxAggregateBytes`. */
export const headerBytes = (name: string, value: string): number =>
  utf8.encode(name).length + utf8.encode(value).length;

export const HEADERS_TOO_LARGE_MESSAGE = `Headers are too large in total (limit ${HEADER_LIMITS.maxAggregateBytes} bytes)`;

/**
 * Headers the HTTP client must control itself (framing, routing, connection management), plus
 * Content-Type, which is configured through the monitor's body content type.
 */
export const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  'connection',
  'content-length',
  'content-type',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// RFC 9110 "token".
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Visible ASCII, space, tab and obs-text. Excludes CR, LF and NUL, so no header injection.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

export const MonitorHeaderNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a header name')
  .max(
    HEADER_LIMITS.maxNameLength,
    `Header names can be at most ${HEADER_LIMITS.maxNameLength} characters`,
  )
  .regex(
    HEADER_NAME,
    "Header names can only contain letters, digits and - _ . ! # $ % & ' * + ^ ` | ~",
  )
  .refine((name) => !FORBIDDEN_HEADER_NAMES.has(name.toLowerCase()), {
    error: (issue) =>
      String(issue.input).toLowerCase() === 'content-type'
        ? 'Set Content-Type with the body content type field instead'
        : `"${String(issue.input)}" is controlled by the HTTP client and can't be set`,
  });

export const MonitorHeaderValueSchema = z
  .string()
  .min(1, 'Enter a header value')
  .max(
    HEADER_LIMITS.maxValueLength,
    `Header values can be at most ${HEADER_LIMITS.maxValueLength} characters`,
  )
  .regex(HEADER_VALUE, 'Header values must not contain line breaks or control characters')
  .refine((v) => v.trim().length > 0, 'Enter a header value');

/** One header to create or replace. The value is write-only: no API response ever returns it. */
export const MonitorHeaderUpsertSchema = z.object({
  name: MonitorHeaderNameSchema,
  value: MonitorHeaderValueSchema,
});
export type MonitorHeaderUpsert = z.infer<typeof MonitorHeaderUpsertSchema>;

function addDuplicateIssues(
  names: string[],
  ctx: z.RefinementCtx,
  pathOf: (i: number) => PropertyKey[],
) {
  const seen = new Set<string>();
  names.forEach((name, i) => {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', path: pathOf(i), message: `Duplicate header "${name}"` });
    }
    seen.add(key);
  });
}

export const MonitorHeaderListSchema = z
  .array(MonitorHeaderUpsertSchema)
  .max(HEADER_LIMITS.maxCount, `A monitor can have at most ${HEADER_LIMITS.maxCount} headers`)
  .superRefine((headers, ctx) => {
    addDuplicateIssues(
      headers.map((h) => h.name),
      ctx,
      (i) => [i, 'name'],
    );
    const total = headers.reduce((sum, h) => sum + headerBytes(h.name, h.value), 0);
    if (total > HEADER_LIMITS.maxAggregateBytes) {
      ctx.addIssue({ code: 'custom', message: HEADERS_TOO_LARGE_MESSAGE });
    }
  });

/**
 * Header changes are explicit: `upsert` creates or replaces values, `remove` deletes by name.
 * A header that is mentioned in neither list is left exactly as it is.
 */
export const MonitorHeaderUpdateSchema = z
  .object({
    upsert: MonitorHeaderListSchema.default([]),
    remove: z
      .array(z.string().trim().min(1).max(HEADER_LIMITS.maxNameLength))
      .max(HEADER_LIMITS.maxCount)
      .default([]),
  })
  .strict()
  .superRefine((update, ctx) => {
    if (update.upsert.length === 0 && update.remove.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Provide at least one header to upsert or remove' });
    }
    addDuplicateIssues(update.remove, ctx, (i) => ['remove', i]);
    const upserting = new Set(update.upsert.map((h) => h.name.toLowerCase()));
    update.remove.forEach((name, i) => {
      if (upserting.has(name.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['remove', i],
          message: `"${name}" can't be both upserted and removed`,
        });
      }
    });
  });
export type MonitorHeaderUpdate = z.infer<typeof MonitorHeaderUpdateSchema>;
export type MonitorHeaderUpdateInput = z.input<typeof MonitorHeaderUpdateSchema>;

/** What the API reveals about a stored header: that it exists, never what it contains. */
export const MonitorHeaderSummarySchema = z.object({
  name: z.string(),
  configured: z.literal(true),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MonitorHeaderSummary = z.infer<typeof MonitorHeaderSummarySchema>;
