import type { IncidentSeverity, MonitorStatus } from '@rain/shared';
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  incidentEvents,
  incidents,
  monitorChecks,
  monitorHeaders,
  monitors,
  type MonitorHeaderRow,
} from '../db/schema.js';
import {
  planCompletion,
  planRelease,
  type ClaimedMonitor,
  type CompletionSnapshot,
  type DiscardReason,
  type HealthSkipReason,
} from './completion.js';
import type { CheckExecution } from './executor.js';
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from './health.js';
import { planIncident, type IncidentAction } from './incident-rules.js';
import { enqueueIncidentNotifications } from '../notifications/notification-outbox.js';

/** What a recorded check did to the monitor's incidents. */
export type IncidentOutcome = { action: 'OPENED' | 'RESOLVED'; incidentId: string } | null;

export function incidentOutcome(action: IncidentAction, incidentId: string): IncidentOutcome {
  if (action.kind === 'open') return { action: 'OPENED', incidentId };
  if (action.kind === 'resolve') return { action: 'RESOLVED', incidentId };
  return null;
}

export type CompletionResult =
  | { recorded: false; reason: DiscardReason | 'DUPLICATE_ATTEMPT' }
  | {
      recorded: true;
      status: MonitorStatus;
      statusChanged: boolean;
      healthSkipped: HealthSkipReason | null;
      incident: IncidentOutcome;
      /** Notification deliveries queued (in the same transaction) for the incident event. */
      notificationsQueued: number;
    };

/**
 * What the worker needs from storage. Implemented over PostgreSQL below, and in memory for tests
 * (test-support/in-memory-monitoring-store.ts), both applying the rules in completion.ts.
 */
export interface MonitoringStore {
  /**
   * Leases up to `limit` monitors that need a check: queued manual checks first (oldest request
   * first), then due scheduled checks (most overdue first). Skips paused monitors, monitors with a
   * live lease, and rows another worker is claiming right now.
   */
  claim(limit: number, leaseSeconds: number): Promise<ClaimedMonitor[]>;
  /** Encrypted headers of a claimed monitor, read after the claim (never inside it). */
  loadHeaders(monitorId: string): Promise<MonitorHeaderRow[]>;
  /** Records the check and applies it, in one short transaction, if the lease is still ours. */
  complete(claim: ClaimedMonitor, execution: CheckExecution): Promise<CompletionResult>;
  /** Gives the lease back without a check. False when the lease was no longer ours. */
  release(claim: ClaimedMonitor): Promise<boolean>;
}

const completionColumns = {
  name: monitors.name,
  ownerId: monitors.ownerId,
  enabled: monitors.enabled,
  leaseToken: monitors.leaseToken,
  currentStatus: monitors.currentStatus,
  consecutiveFailures: monitors.consecutiveFailures,
  consecutiveSuccesses: monitors.consecutiveSuccesses,
  statusChangedAt: monitors.statusChangedAt,
  nextCheckAt: monitors.nextCheckAt,
  checkIntervalSeconds: monitors.checkIntervalSeconds,
  manualCheckRequestedAt: monitors.manualCheckRequestedAt,
  lastManualCheckAt: monitors.lastManualCheckAt,
  // Transaction start time from the database clock, shared by every worker instance.
  dbNow: sql`now()`.mapWith(monitors.nextCheckAt),
};

// Worker writes are bookkeeping, not configuration edits: keep updated_at as it is.
const keepUpdatedAt = { updatedAt: sql`${monitors.updatedAt}` };

export function createMonitoringStore(
  db: Database,
  options: { thresholds?: HealthThresholds } = {},
): MonitoringStore {
  const thresholds = options.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;

  return {
    async claim(limit, leaseSeconds) {
      if (limit <= 0) return [];
      // The CTE is evaluated once: its FOR UPDATE SKIP LOCKED makes concurrent workers pick
      // disjoint rows, and the UPDATE takes the lease in the same statement (autocommit), so no
      // transaction stays open while checks run.
      const candidates = db.$with('candidates').as(
        db
          .select({ id: monitors.id })
          .from(monitors)
          .where(
            and(
              eq(monitors.enabled, true),
              or(isNull(monitors.leaseUntil), lt(monitors.leaseUntil, sql`now()`)),
              or(isNotNull(monitors.manualCheckRequestedAt), lte(monitors.nextCheckAt, sql`now()`)),
            ),
          )
          .orderBy(
            sql`${monitors.manualCheckRequestedAt} ASC NULLS LAST`,
            asc(monitors.nextCheckAt),
          )
          .limit(limit)
          .for('update', { skipLocked: true }),
      );
      const rows = await db
        .with(candidates)
        .update(monitors)
        .set({
          leaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
          leaseToken: sql`gen_random_uuid()`,
          ...keepUpdatedAt,
        })
        .where(inArray(monitors.id, db.select({ id: candidates.id }).from(candidates)))
        .returning({
          ...getTableColumns(monitors),
          claimedAt: sql`now()`.mapWith(monitors.nextCheckAt),
          due: sql<boolean>`${monitors.nextCheckAt} <= now()`.mapWith(Boolean),
        });
      return rows.map(({ claimedAt, due, ...monitor }) => ({
        monitor,
        leaseToken: monitor.leaseToken!,
        claimedAt: claimedAt as Date,
        due,
        manualRequestedAt: monitor.manualCheckRequestedAt,
      }));
    },

    loadHeaders(monitorId) {
      return db
        .select()
        .from(monitorHeaders)
        .where(eq(monitorHeaders.monitorId, monitorId))
        .orderBy(sql`lower(${monitorHeaders.headerName})`);
    },

    complete(claim, execution) {
      return db.transaction(async (tx): Promise<CompletionResult> => {
        // 1. Lock the monitor row (and read the lease) for the rest of this short transaction.
        const [locked] = await tx
          .select(completionColumns)
          .from(monitors)
          .where(eq(monitors.id, claim.monitor.id))
          .for('update');
        const current: CompletionSnapshot | undefined = locked;
        const plan = planCompletion(
          current,
          claim,
          execution,
          (locked?.dbNow as Date | undefined) ?? new Date(),
          thresholds,
        );
        // 2. Stale or deleted: write nothing at all.
        if (plan.kind === 'discard') return { recorded: false, reason: plan.reason };

        // 3. Insert the result; the attempt ID makes a retried completion a no-op.
        const inserted = await tx
          .insert(monitorChecks)
          .values(plan.check)
          .onConflictDoNothing({ target: monitorChecks.attemptId })
          .returning({ id: monitorChecks.id });
        if (inserted.length === 0) return { recorded: false, reason: 'DUPLICATE_ATTEMPT' };

        // Incident lifecycle, in the same transaction and under the same monitor row lock, so two
        // workers can never both open one (the partial unique index is the backstop).
        let incident: IncidentOutcome = null;
        let notificationsQueued = 0;
        if (plan.transition) {
          const [active] = await tx
            .select({
              id: incidents.id,
              title: incidents.title,
              severity: incidents.severity,
              description: incidents.description,
              startedAt: incidents.startedAt,
            })
            .from(incidents)
            .where(and(eq(incidents.monitorId, claim.monitor.id), ne(incidents.status, 'RESOLVED')))
            .for('update');
          const action = planIncident({
            transition: plan.transition,
            active: active ?? null,
            monitorName: current!.name,
            check: { id: inserted[0]!.id, ...execution },
            thresholds,
          });
          if (action.kind === 'open') {
            const [opened] = await tx
              .insert(incidents)
              .values({
                monitorId: claim.monitor.id,
                ownerId: current!.ownerId,
                title: action.title,
                description: action.description,
                severity: action.severity,
                status: 'OPEN',
                startedAt: action.startedAt,
                triggerCheckId: action.triggerCheckId,
              })
              .returning({ id: incidents.id });
            const [created] = await tx
              .insert(incidentEvents)
              .values({
                incidentId: opened!.id,
                eventType: 'INCIDENT_CREATED',
                occurredAt: action.startedAt,
                description: action.eventDescription,
                checkId: action.triggerCheckId,
              })
              .returning({ id: incidentEvents.id });
            incident = incidentOutcome(action, opened!.id);
            // Outbox rows commit (or roll back) with the incident and its event.
            notificationsQueued = await enqueueIncidentNotifications(tx, {
              eventId: created!.id,
              eventType: 'INCIDENT_CREATED',
              occurredAt: action.startedAt,
              incident: {
                id: opened!.id,
                title: action.title,
                severity: action.severity,
                status: 'OPEN',
                summary: action.description,
                startedAt: action.startedAt,
                resolvedAt: null,
              },
              monitor: { id: claim.monitor.id, name: current!.name },
              ownerId: current!.ownerId,
            });
          } else if (action.kind === 'resolve') {
            await tx
              .update(incidents)
              .set({
                status: 'RESOLVED',
                resolvedAt: action.resolvedAt,
                resolvedByCheckId: action.resolvedByCheckId,
              })
              .where(and(eq(incidents.id, action.incidentId), ne(incidents.status, 'RESOLVED')));
            const [resolvedEvent] = await tx
              .insert(incidentEvents)
              .values({
                incidentId: action.incidentId,
                eventType: 'INCIDENT_RESOLVED',
                occurredAt: action.resolvedAt,
                description: action.eventDescription,
                checkId: action.resolvedByCheckId,
              })
              .returning({ id: incidentEvents.id });
            incident = incidentOutcome(action, action.incidentId);
            notificationsQueued = await enqueueIncidentNotifications(tx, {
              eventId: resolvedEvent!.id,
              eventType: 'INCIDENT_RESOLVED',
              occurredAt: action.resolvedAt,
              incident: {
                id: action.incidentId,
                title: active!.title,
                severity: active!.severity as IncidentSeverity,
                status: 'RESOLVED',
                summary: action.eventDescription,
                startedAt: active!.startedAt,
                resolvedAt: action.resolvedAt,
              },
              monitor: { id: claim.monitor.id, name: current!.name },
              ownerId: current!.ownerId,
            });
          }
        }

        // 4–6. Health, status_changed_at, next check and lease release, guarded by the token.
        await tx
          .update(monitors)
          .set({ ...plan.update, ...keepUpdatedAt })
          .where(and(eq(monitors.id, claim.monitor.id), eq(monitors.leaseToken, claim.leaseToken)));
        return {
          recorded: true,
          status: plan.update.currentStatus ?? (current!.currentStatus as MonitorStatus),
          statusChanged: plan.transition?.statusChanged ?? false,
          healthSkipped: plan.healthSkipped,
          incident,
          notificationsQueued,
        };
      });
    },

    release(claim) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select(completionColumns)
          .from(monitors)
          .where(eq(monitors.id, claim.monitor.id))
          .for('update');
        const plan = planRelease(locked, claim, (locked?.dbNow as Date | undefined) ?? new Date());
        if (plan.kind === 'discard') return false;
        await tx
          .update(monitors)
          .set({ ...plan.update, ...keepUpdatedAt })
          .where(and(eq(monitors.id, claim.monitor.id), eq(monitors.leaseToken, claim.leaseToken)));
        return true;
      });
    },
  };
}
