import { HEADER_LIMITS, MONITOR_LIMITS, MONITOR_METHODS, MONITOR_STATUSES } from '@rain/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { authUsers } from 'drizzle-orm/supabase';

export const profiles = pgTable('profiles', {
  id: uuid('id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  // RLS with no policies: Supabase's public REST API (anon/authenticated roles) can't read or
  // write this table. Only the API server, connecting as the table owner, has access.
}).enableRLS();

export type ProfileRow = typeof profiles.$inferSelect;

const L = MONITOR_LIMITS;
// Compile-time constants from the shared contract, so the database enforces the same bounds.
const quotedList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Ownership chain for deletes: auth.users -> profiles -> monitors -> monitor_headers, all
 * ON DELETE CASCADE. Future per-monitor tables (checks, incidents) must also cascade from
 * monitors, and incidents must not hold foreign keys to raw check rows, so that deleting a
 * monitor or expiring old checks can never be blocked.
 */
export const monitors = pgTable(
  'monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: L.nameMaxLength }).notNull(),
    description: text('description'),
    url: varchar('url', { length: L.urlMaxLength }).notNull(),
    method: varchar('method', { length: 10 }).notNull(),
    expectedStatusCode: integer('expected_status_code').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    latencyThresholdMs: integer('latency_threshold_ms').notNull(),
    checkIntervalSeconds: integer('check_interval_seconds').notNull(),
    // The request body is encrypted at rest (AES-256-GCM); all four columns are set together.
    requestBodyCiphertext: text('request_body_ciphertext'),
    requestBodyIv: text('request_body_iv'),
    requestBodyAuthTag: text('request_body_auth_tag'),
    requestBodyKeyVersion: integer('request_body_key_version'),
    bodyContentType: varchar('body_content_type', { length: L.bodyContentTypeMaxLength }),
    // Paused is `enabled = false`; current_status keeps the last observed health untouched.
    enabled: boolean('enabled').notNull().default(true),
    currentStatus: varchar('current_status', { length: 20 }).notNull().default('UNKNOWN'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    // Reserved for the worker: a claimed monitor is leased until this time.
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    // Millisecond precision so keyset-pagination cursors round-trip exactly through JavaScript.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('monitors_owner_id_idx').on(t.ownerId),
    index('monitors_owner_created_idx').on(t.ownerId, t.createdAt.desc(), t.id.desc()),
    // For the future scheduler: "enabled monitors that are due", without scanning paused ones.
    index('monitors_due_idx')
      .on(t.enabled, t.nextCheckAt)
      .where(sql`${t.enabled} = true`),
    check('monitors_name_not_blank', sql`char_length(btrim(${t.name})) > 0`),
    check(
      'monitors_description_length',
      sql`${t.description} IS NULL OR char_length(${t.description}) <= ${sql.raw(String(L.descriptionMaxLength))}`,
    ),
    check('monitors_method_valid', sql`${t.method} IN (${quotedList(MONITOR_METHODS)})`),
    check('monitors_status_valid', sql`${t.currentStatus} IN (${quotedList(MONITOR_STATUSES)})`),
    check(
      'monitors_expected_status_range',
      sql`${t.expectedStatusCode} BETWEEN ${sql.raw(String(L.expectedStatusCode.min))} AND ${sql.raw(String(L.expectedStatusCode.max))}`,
    ),
    check(
      'monitors_timeout_range',
      sql`${t.timeoutMs} BETWEEN ${sql.raw(String(L.timeoutMs.min))} AND ${sql.raw(String(L.timeoutMs.max))}`,
    ),
    check(
      'monitors_latency_threshold_range',
      sql`${t.latencyThresholdMs} BETWEEN ${sql.raw(String(L.latencyThresholdMs.min))} AND ${t.timeoutMs}`,
    ),
    check(
      'monitors_interval_range',
      sql`${t.checkIntervalSeconds} BETWEEN ${sql.raw(String(L.checkIntervalSeconds.min))} AND ${sql.raw(String(L.checkIntervalSeconds.max))}`,
    ),
    check(
      'monitors_request_body_complete',
      sql`num_nonnulls(${t.requestBodyCiphertext}, ${t.requestBodyIv}, ${t.requestBodyAuthTag}, ${t.requestBodyKeyVersion}) IN (0, 4)`,
    ),
    check(
      'monitors_body_method',
      sql`${t.requestBodyCiphertext} IS NULL OR ${t.method} IN ('POST', 'PUT', 'PATCH')`,
    ),
    check(
      'monitors_body_content_type',
      sql`${t.bodyContentType} IS NULL OR ${t.requestBodyCiphertext} IS NOT NULL`,
    ),
    check(
      'monitors_counters_non_negative',
      sql`${t.consecutiveFailures} >= 0 AND ${t.consecutiveSuccesses} >= 0`,
    ),
  ],
).enableRLS();

export type MonitorRow = typeof monitors.$inferSelect;

/** Custom request headers. Every value is treated as a credential and stored only encrypted. */
export const monitorHeaders = pgTable(
  'monitor_headers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    headerName: varchar('header_name', { length: HEADER_LIMITS.maxNameLength }).notNull(),
    valueCiphertext: text('value_ciphertext').notNull(),
    valueIv: text('value_iv').notNull(),
    valueAuthTag: text('value_auth_tag').notNull(),
    encryptionKeyVersion: integer('encryption_key_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // HTTP header names are case-insensitive: "Authorization" and "authorization" are one header.
    uniqueIndex('monitor_headers_monitor_name_uq').on(t.monitorId, sql`lower(${t.headerName})`),
    check('monitor_headers_name_not_blank', sql`char_length(${t.headerName}) > 0`),
    check('monitor_headers_key_version_positive', sql`${t.encryptionKeyVersion} > 0`),
  ],
).enableRLS();

export type MonitorHeaderRow = typeof monitorHeaders.$inferSelect;
