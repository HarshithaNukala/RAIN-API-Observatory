import {
  CHECK_ERROR_MESSAGE_MAX_LENGTH,
  CHECK_FAILURE_REASONS,
  HEADER_LIMITS,
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_EVENT_TYPES,
  INCIDENT_LIMITS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  NOTIFICATION_ATTEMPT_OUTCOMES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_LIMITS,
  NOTIFICATION_STATUSES,
  STATUS_PAGE_LIMITS,
  MONITOR_CHECK_OUTCOMES,
  MONITOR_CHECK_SOURCES,
  MONITOR_LIMITS,
  MONITOR_METHODS,
  MONITOR_STATUSES,
} from '@rain/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    // The owner's explicit consent to scheduled POST/PUT/PATCH requests, which may create or
    // modify data on the target. Never set implicitly; the executor refuses those methods without
    // it. No CHECK ties it to the method, so existing rows can keep false until the owner decides.
    allowMutatingRequests: boolean('allow_mutating_requests').notNull().default(false),
    // Paused is `enabled = false`; current_status keeps the last observed health untouched.
    enabled: boolean('enabled').notNull().default(true),
    currentStatus: varchar('current_status', { length: 20 }).notNull().default('UNKNOWN'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    // When current_status last changed; NULL until the first transition out of UNKNOWN.
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    // Worker lease: a claimed monitor is leased until lease_until by the holder of lease_token.
    // Both are set together on claim and cleared together on completion. An expired lease may be
    // re-claimed; the old holder's completion is then rejected because its token no longer matches.
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    // Manual check queue: set by POST /monitors/:id/check, cleared by the worker that ran it.
    manualCheckRequestedAt: timestamp('manual_check_requested_at', {
      withTimezone: true,
      precision: 3,
    }),
    lastManualCheckAt: timestamp('last_manual_check_at', { withTimezone: true, precision: 3 }),
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
    // Queued manual checks, oldest first. Only rows with a pending request are indexed.
    index('monitors_manual_queue_idx')
      .on(t.manualCheckRequestedAt)
      .where(sql`${t.manualCheckRequestedAt} IS NOT NULL`),
    check('monitors_lease_complete', sql`(${t.leaseUntil} IS NULL) = (${t.leaseToken} IS NULL)`),
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

/**
 * One row per executed health check. Deleted with its monitor (ON DELETE CASCADE). Nothing may
 * hold a foreign key to these rows, so old checks can be expired freely.
 */
export const monitorChecks = pgTable(
  'monitor_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true, precision: 3 }).notNull(),
    /** What started the check: SCHEDULED (the cadence) or MANUAL (Check Now). */
    source: varchar('source', { length: 10 }).notNull().default('SCHEDULED'),
    /**
     * One attempt = one claim (its lease token). Unique, so a completion that is retried after a
     * lost acknowledgement can never record the same attempt twice.
     */
    attemptId: uuid('attempt_id').notNull().defaultRandom(),
    outcome: varchar('outcome', { length: 10 }).notNull(),
    /** NULL when no HTTP response was received. */
    statusCode: integer('status_code'),
    /** Time to response in milliseconds; NULL exactly when there was no HTTP response. */
    latencyMs: integer('latency_ms'),
    failureReason: varchar('failure_reason', { length: 30 }),
    /** Sanitised, user-safe description; never a raw stack trace or secret. */
    errorMessage: varchar('error_message', { length: CHECK_ERROR_MESSAGE_MAX_LENGTH }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // History for one monitor, newest first.
    index('monitor_checks_monitor_checked_idx').on(t.monitorId, t.checkedAt.desc()),
    // Retention: expire checks older than a cutoff across all monitors.
    index('monitor_checks_checked_at_idx').on(t.checkedAt),
    uniqueIndex('monitor_checks_attempt_id_uq').on(t.attemptId),
    // History filtered by source (GET /checks?source=MANUAL), newest first.
    index('monitor_checks_monitor_source_checked_idx').on(
      t.monitorId,
      t.source,
      t.checkedAt.desc(),
    ),
    check(
      'monitor_checks_source_valid',
      sql`${t.source} IN (${quotedList(MONITOR_CHECK_SOURCES)})`,
    ),
    check(
      'monitor_checks_outcome_valid',
      sql`${t.outcome} IN (${quotedList(MONITOR_CHECK_OUTCOMES)})`,
    ),
    check(
      'monitor_checks_failure_reason_valid',
      sql`${t.failureReason} IS NULL OR ${t.failureReason} IN (${quotedList(CHECK_FAILURE_REASONS)})`,
    ),
    // A failure always says why; a passing check never has a failure reason.
    check(
      'monitor_checks_reason_matches_outcome',
      sql`(${t.outcome} = 'FAILURE') = (${t.failureReason} IS NOT NULL)`,
    ),
    // Latency exists exactly when an HTTP response was received.
    check(
      'monitor_checks_latency_requires_response',
      sql`(${t.statusCode} IS NULL) = (${t.latencyMs} IS NULL)`,
    ),
    // Only UNEXPECTED_STATUS failures (and passing checks) come with a response.
    check(
      'monitor_checks_response_matches_reason',
      sql`(${t.statusCode} IS NOT NULL) = (${t.failureReason} IS NULL OR ${t.failureReason} = 'UNEXPECTED_STATUS')`,
    ),
    check(
      'monitor_checks_status_code_range',
      sql`${t.statusCode} IS NULL OR ${t.statusCode} BETWEEN 100 AND 599`,
    ),
    check(
      'monitor_checks_latency_non_negative',
      sql`${t.latencyMs} IS NULL OR ${t.latencyMs} >= 0`,
    ),
  ],
).enableRLS();

export type MonitorCheckRow = typeof monitorChecks.$inferSelect;
export type NewMonitorCheckRow = typeof monitorChecks.$inferInsert;

/**
 * Outages. Opened by the worker when a monitor reaches DOWN, resolved by the worker after the
 * recovery threshold, acknowledged by the owner. Cascades from monitors (and so from the owner).
 *
 * `trigger_check_id` and `resolved_by_check_id` are plain UUIDs, deliberately without foreign keys
 * to `monitor_checks`, so check history can be expired without touching incidents.
 */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    // Denormalised from the monitor so every query can be owner-scoped without a join.
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: INCIDENT_LIMITS.titleMaxLength }).notNull(),
    description: text('description'),
    severity: varchar('severity', { length: 10 }).notNull().default(DEFAULT_INCIDENT_SEVERITY),
    status: varchar('status', { length: 15 }).notNull().default('OPEN'),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, precision: 3 }),
    acknowledgedBy: uuid('acknowledged_by').references(() => profiles.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, precision: 3 }),
    triggerCheckId: uuid('trigger_check_id'),
    resolvedByCheckId: uuid('resolved_by_check_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // At most one active (OPEN or ACKNOWLEDGED) incident per monitor, even under races.
    uniqueIndex('incidents_one_active_per_monitor_uq')
      .on(t.monitorId)
      .where(sql`${t.status} <> 'RESOLVED'`),
    // Owner's incident list, newest first (keyset pagination), and status counts.
    index('incidents_owner_started_idx').on(t.ownerId, t.startedAt.desc(), t.id.desc()),
    index('incidents_owner_status_idx').on(t.ownerId, t.status),
    // A monitor's incident history.
    index('incidents_monitor_started_idx').on(t.monitorId, t.startedAt.desc()),
    check('incidents_status_valid', sql`${t.status} IN (${quotedList(INCIDENT_STATUSES)})`),
    check('incidents_severity_valid', sql`${t.severity} IN (${quotedList(INCIDENT_SEVERITIES)})`),
    check('incidents_title_not_blank', sql`char_length(btrim(${t.title})) > 0`),
    check(
      'incidents_description_length',
      sql`${t.description} IS NULL OR char_length(${t.description}) <= ${sql.raw(String(INCIDENT_LIMITS.descriptionMaxLength))}`,
    ),
    // Status and timestamps agree: acknowledged incidents say when, resolved ones say when.
    check(
      'incidents_acknowledged_consistent',
      sql`(${t.status} = 'ACKNOWLEDGED') <= (${t.acknowledgedAt} IS NOT NULL)`,
    ),
    check(
      'incidents_resolved_consistent',
      sql`(${t.status} = 'RESOLVED') = (${t.resolvedAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();

export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncidentRow = typeof incidents.$inferInsert;

/**
 * The permanent, append-only timeline of an incident. Rows are written in the same transaction as
 * the change they describe; a trigger (migration 0005) rejects UPDATEs. They go away only with
 * their incident (cascade).
 */
export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 30 }).notNull(),
    /** NULL for events recorded by the monitoring engine (SYSTEM). */
    actorId: uuid('actor_id').references(() => profiles.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
    /** Generated, safe text: never request content, headers or URL query strings. */
    description: varchar('description', {
      length: INCIDENT_LIMITS.eventDescriptionMaxLength,
    }).notNull(),
    /** The check behind a system event; no foreign key (checks can expire). */
    checkId: uuid('check_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    // Timeline order.
    index('incident_events_incident_occurred_idx').on(t.incidentId, t.occurredAt, t.id),
    // One check can't produce the same event twice (backstop to the attempt-ID idempotency).
    uniqueIndex('incident_events_check_once_uq')
      .on(t.incidentId, t.eventType, t.checkId)
      .where(sql`${t.checkId} IS NOT NULL`),
    check(
      'incident_events_type_valid',
      sql`${t.eventType} IN (${quotedList(INCIDENT_EVENT_TYPES)})`,
    ),
  ],
).enableRLS();

export type IncidentEventRow = typeof incidentEvents.$inferSelect;
export type NewIncidentEventRow = typeof incidentEvents.$inferInsert;

/**
 * Per-monitor notification preferences. No row means nothing is enabled: a notification is only
 * queued for a channel that the owner has configured and switched on.
 *
 * The webhook signing secret (generated by RAIN) and the optional authentication header value are
 * stored only encrypted (AES-256-GCM, same secret box and key rotation as monitor headers).
 */
export const monitorNotificationSettings = pgTable(
  'monitor_notification_settings',
  {
    monitorId: uuid('monitor_id')
      .primaryKey()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    emailEnabled: boolean('email_enabled').notNull().default(false),
    webhookEnabled: boolean('webhook_enabled').notNull().default(false),
    webhookUrl: varchar('webhook_url', { length: NOTIFICATION_LIMITS.webhookUrlMaxLength }),
    webhookSecretCiphertext: text('webhook_secret_ciphertext'),
    webhookSecretIv: text('webhook_secret_iv'),
    webhookSecretAuthTag: text('webhook_secret_auth_tag'),
    webhookSecretKeyVersion: integer('webhook_secret_key_version'),
    webhookHeaderName: varchar('webhook_header_name', { length: HEADER_LIMITS.maxNameLength }),
    webhookHeaderCiphertext: text('webhook_header_ciphertext'),
    webhookHeaderIv: text('webhook_header_iv'),
    webhookHeaderAuthTag: text('webhook_header_auth_tag'),
    webhookHeaderKeyVersion: integer('webhook_header_key_version'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // A configured webhook has a URL and a complete signing secret; an enabled one is configured.
    check(
      'monitor_notification_settings_webhook_complete',
      sql`num_nonnulls(${t.webhookUrl}, ${t.webhookSecretCiphertext}, ${t.webhookSecretIv}, ${t.webhookSecretAuthTag}, ${t.webhookSecretKeyVersion}) IN (0, 5)`,
    ),
    check(
      'monitor_notification_settings_webhook_enabled_configured',
      sql`NOT ${t.webhookEnabled} OR ${t.webhookUrl} IS NOT NULL`,
    ),
    check(
      'monitor_notification_settings_header_complete',
      sql`num_nonnulls(${t.webhookHeaderName}, ${t.webhookHeaderCiphertext}, ${t.webhookHeaderIv}, ${t.webhookHeaderAuthTag}, ${t.webhookHeaderKeyVersion}) IN (0, 5)`,
    ),
    check(
      'monitor_notification_settings_header_needs_webhook',
      sql`${t.webhookHeaderName} IS NULL OR ${t.webhookUrl} IS NOT NULL`,
    ),
  ],
).enableRLS();

export type MonitorNotificationSettingsRow = typeof monitorNotificationSettings.$inferSelect;
export type NewMonitorNotificationSettingsRow = typeof monitorNotificationSettings.$inferInsert;

/**
 * The transactional outbox: one row per incident event per channel. Rows are inserted in the
 * same transaction as the incident event; the worker's dispatcher claims and delivers them later.
 * `(event_id, channel)` is unique, so a repeated or retried event can never queue a second job.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    /** The incident_events row this notifies about (no FK: the timeline is append-only). */
    eventId: uuid('event_id').notNull(),
    eventType: varchar('event_type', { length: 30 }).notNull(),
    channel: varchar('channel', { length: 10 }).notNull(),
    /** Safe event snapshot (NotificationPayload): no URLs, headers, bodies or credentials. */
    payload: jsonb('payload').notNull(),
    /** Safe, displayable destination (masked email or webhook host), fixed at queue time. */
    destination: varchar('destination', { length: 300 }).notNull(),
    status: varchar('status', { length: 12 }).notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(NOTIFICATION_LIMITS.maxAttempts),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true, precision: 3 }),
    leaseToken: uuid('lease_token'),
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true, precision: 3 }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, precision: 3 }),
    lastError: varchar('last_error', { length: NOTIFICATION_LIMITS.errorMaxLength }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('notification_deliveries_event_channel_uq').on(t.eventId, t.channel),
    // The dispatcher's queue: due PENDING rows, and PROCESSING rows whose lease may have expired.
    index('notification_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'PENDING'`),
    index('notification_deliveries_processing_idx')
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'PROCESSING'`),
    // Owner's history, newest first (keyset pagination).
    index('notification_deliveries_owner_created_idx').on(
      t.ownerId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('notification_deliveries_incident_idx').on(t.incidentId),
    check(
      'notification_deliveries_event_type_valid',
      sql`${t.eventType} IN (${quotedList(NOTIFICATION_EVENT_TYPES)})`,
    ),
    check(
      'notification_deliveries_channel_valid',
      sql`${t.channel} IN (${quotedList(NOTIFICATION_CHANNELS)})`,
    ),
    check(
      'notification_deliveries_status_valid',
      sql`${t.status} IN (${quotedList(NOTIFICATION_STATUSES)})`,
    ),
    check(
      'notification_deliveries_attempts_bounds',
      sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`,
    ),
    check(
      'notification_deliveries_lease_complete',
      sql`(${t.leaseUntil} IS NULL) = (${t.leaseToken} IS NULL)`,
    ),
    check(
      'notification_deliveries_processing_leased',
      sql`(${t.status} = 'PROCESSING') = (${t.leaseToken} IS NOT NULL)`,
    ),
    check(
      'notification_deliveries_sent_consistent',
      sql`(${t.status} = 'SENT') = (${t.deliveredAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();

export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDeliveryRow = typeof notificationDeliveries.$inferInsert;

/** One row per delivery attempt, for the delivery history. Cascades with its delivery. */
export const notificationAttempts = pgTable(
  'notification_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => notificationDeliveries.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, precision: 3 }).notNull(),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    httpStatus: integer('http_status'),
    error: varchar('error', { length: NOTIFICATION_LIMITS.errorMaxLength }),
  },
  (t) => [
    uniqueIndex('notification_attempts_delivery_number_uq').on(t.deliveryId, t.attemptNumber),
    check(
      'notification_attempts_outcome_valid',
      sql`${t.outcome} IN (${quotedList(NOTIFICATION_ATTEMPT_OUTCOMES)})`,
    ),
  ],
).enableRLS();

export type NotificationAttemptRow = typeof notificationAttempts.$inferSelect;

/**
 * Public status pages. Owned by one user (cascade with the profile); `slug` is the public address
 * (`/status/<slug>`), globally unique. Unpublished pages are invisible to the public endpoint.
 */
export const statusPages = pgTable(
  'status_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: STATUS_PAGE_LIMITS.titleMaxLength }).notNull(),
    description: text('description'),
    slug: varchar('slug', { length: STATUS_PAGE_LIMITS.slug.max }).notNull(),
    published: boolean('published').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('status_pages_slug_uq').on(t.slug),
    index('status_pages_owner_created_idx').on(t.ownerId, t.createdAt.desc()),
    // Same rule as StatusPageSlugSchema: lowercase letters, digits, single inner hyphens.
    check(
      'status_pages_slug_format',
      sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,62}[a-z0-9]$'`,
    ),
    check('status_pages_title_not_blank', sql`char_length(btrim(${t.title})) > 0`),
    check(
      'status_pages_description_length',
      sql`${t.description} IS NULL OR char_length(${t.description}) <= ${sql.raw(String(STATUS_PAGE_LIMITS.descriptionMaxLength))}`,
    ),
    check(
      'status_pages_published_consistent',
      sql`NOT ${t.published} OR ${t.publishedAt} IS NOT NULL`,
    ),
  ],
).enableRLS();

export type StatusPageRow = typeof statusPages.$inferSelect;
export type NewStatusPageRow = typeof statusPages.$inferInsert;

/**
 * The monitors shown on a page, under public names, in order. The primary key prevents duplicates;
 * deleting the page or the monitor removes the row. A trigger (migration 0007) rejects rows whose
 * monitor belongs to someone other than the page owner.
 */
export const statusPageMonitors = pgTable(
  'status_page_monitors',
  {
    statusPageId: uuid('status_page_id')
      .notNull()
      .references(() => statusPages.id, { onDelete: 'cascade' }),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    displayName: varchar('display_name', {
      length: STATUS_PAGE_LIMITS.displayNameMaxLength,
    }).notNull(),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.statusPageId, t.monitorId] }),
    index('status_page_monitors_page_position_idx').on(t.statusPageId, t.position),
    index('status_page_monitors_monitor_idx').on(t.monitorId),
    check('status_page_monitors_position_non_negative', sql`${t.position} >= 0`),
    check(
      'status_page_monitors_display_name_not_blank',
      sql`char_length(btrim(${t.displayName})) > 0`,
    ),
  ],
).enableRLS();

export type StatusPageMonitorRow = typeof statusPageMonitors.$inferSelect;
