import { randomUUID } from 'node:crypto';
import type { IncidentSeverity, MonitorStatus } from '@rain/shared';
import type { MonitorCheckRow, MonitorRow } from '../db/schema.js';
import { planCompletion, planRelease, type ClaimedMonitor } from '../monitoring/completion.js';
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from '../monitoring/health.js';
import { planIncident } from '../monitoring/incident-rules.js';
import { enqueueInMemory } from './in-memory-notifications.js';
import {
  incidentOutcome,
  type IncidentOutcome,
  type MonitoringStore,
} from '../monitoring/monitoring-store.js';
import type { InMemoryMonitorRepository } from './in-memory-monitor-repository.js';

/**
 * Test stand-in for the PostgreSQL monitoring store, working on the same rows as an in-memory
 * monitor repository so API and worker tests share state. It applies the same claim filter and
 * order and the same completion rules (completion.ts). It cannot prove SKIP LOCKED or the SQL:
 * that is the integration suite's job.
 */
export interface InMemoryMonitoringStore extends MonitoringStore {
  /** Calls made, for assertions. */
  readonly calls: { claim: number; complete: number; release: number };
  /** Makes the next call of this kind throw (simulating a database interruption). */
  /** `incident` fails inside completion, after the check row was written (tests the rollback). */
  failNext(
    kind: 'claim' | 'loadHeaders' | 'complete' | 'incident' | 'release',
    error?: Error,
  ): void;
}

export function createInMemoryMonitoringStore(
  repo: InMemoryMonitorRepository,
  options: { now?: () => Date; thresholds?: HealthThresholds } = {},
): InMemoryMonitoringStore {
  const now = options.now ?? (() => new Date());
  const thresholds = options.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;
  const calls = { claim: 0, complete: 0, release: 0 };
  const failures = new Map<string, Error>();

  const maybeFail = (kind: string) => {
    const err = failures.get(kind);
    if (err) {
      failures.delete(kind);
      throw err;
    }
  };
  const find = (id: string): MonitorRow | undefined => repo.monitors.find((m) => m.id === id);

  return {
    calls,
    failNext(kind, error = new Error('connection terminated unexpectedly')) {
      failures.set(kind, error);
    },

    async claim(limit, leaseSeconds) {
      calls.claim++;
      maybeFail('claim');
      if (limit <= 0) return [];
      const at = now();
      const t = at.getTime();
      const candidates = repo.monitors
        .filter(
          (m) =>
            m.enabled &&
            (m.leaseUntil === null || m.leaseUntil.getTime() < t) &&
            (m.manualCheckRequestedAt !== null || m.nextCheckAt.getTime() <= t),
        )
        .sort(
          (a, b) =>
            (a.manualCheckRequestedAt?.getTime() ?? Infinity) -
              (b.manualCheckRequestedAt?.getTime() ?? Infinity) ||
            a.nextCheckAt.getTime() - b.nextCheckAt.getTime(),
        )
        .slice(0, limit);
      return candidates.map((m) => {
        m.leaseUntil = new Date(t + leaseSeconds * 1000);
        m.leaseToken = randomUUID();
        return {
          monitor: { ...m },
          leaseToken: m.leaseToken,
          claimedAt: at,
          due: m.nextCheckAt.getTime() <= t,
          manualRequestedAt: m.manualCheckRequestedAt,
        } satisfies ClaimedMonitor;
      });
    },

    async loadHeaders(monitorId) {
      maybeFail('loadHeaders');
      return repo.headers.filter((h) => h.monitorId === monitorId).map((h) => ({ ...h }));
    },

    async complete(claim, execution) {
      calls.complete++;
      maybeFail('complete');
      const current = find(claim.monitor.id);
      const plan = planCompletion(current, claim, execution, now(), thresholds);
      if (plan.kind === 'discard') return { recorded: false, reason: plan.reason };
      if (repo.checks.some((c) => c.attemptId === claim.leaseToken)) {
        return { recorded: false, reason: 'DUPLICATE_ATTEMPT' };
      }
      const row: MonitorCheckRow = {
        id: randomUUID(),
        monitorId: plan.check.monitorId,
        checkedAt: plan.check.checkedAt,
        source: plan.check.source ?? 'SCHEDULED',
        attemptId: plan.check.attemptId!,
        outcome: plan.check.outcome,
        statusCode: plan.check.statusCode ?? null,
        latencyMs: plan.check.latencyMs ?? null,
        failureReason: plan.check.failureReason ?? null,
        errorMessage: plan.check.errorMessage ?? null,
        createdAt: now(),
      };
      // Everything below commits together: a failure restores the snapshot (like a rollback).
      const snapshot = {
        checks: [...repo.checks],
        incidents: repo.incidents.map((i) => ({ ...i })),
        incidentEvents: [...repo.incidentEvents],
        notificationDeliveries: [...repo.notificationDeliveries],
        monitor: { ...current! },
      };
      let incident: IncidentOutcome = null;
      let notificationsQueued = 0;
      try {
        repo.checks.push(row);
        if (plan.transition) {
          const active = repo.incidents.find(
            (i) => i.monitorId === claim.monitor.id && i.status !== 'RESOLVED',
          );
          const action = planIncident({
            transition: plan.transition,
            active: active ? { id: active.id } : null,
            monitorName: current!.name,
            check: { id: row.id, ...execution },
            thresholds,
          });
          maybeFail('incident');
          const at = now();
          if (action.kind === 'open') {
            // The partial unique index, emulated.
            if (
              repo.incidents.some(
                (i) => i.monitorId === claim.monitor.id && i.status !== 'RESOLVED',
              )
            ) {
              throw new Error('unique violation: incidents_one_active_per_monitor_uq');
            }
            const id = randomUUID();
            repo.incidents.push({
              id,
              monitorId: claim.monitor.id,
              ownerId: current!.ownerId,
              title: action.title,
              description: action.description,
              severity: action.severity,
              status: 'OPEN',
              startedAt: action.startedAt,
              acknowledgedAt: null,
              acknowledgedBy: null,
              resolvedAt: null,
              triggerCheckId: action.triggerCheckId,
              resolvedByCheckId: null,
              createdAt: at,
              updatedAt: at,
            });
            const createdEventId = randomUUID();
            repo.incidentEvents.push({
              id: createdEventId,
              incidentId: id,
              eventType: 'INCIDENT_CREATED',
              actorId: null,
              occurredAt: action.startedAt,
              description: action.eventDescription,
              checkId: action.triggerCheckId,
              createdAt: at,
            });
            incident = incidentOutcome(action, id);
            notificationsQueued = enqueueInMemory(
              repo,
              {
                eventId: createdEventId,
                eventType: 'INCIDENT_CREATED',
                occurredAt: action.startedAt,
                incident: {
                  id,
                  title: action.title,
                  severity: action.severity,
                  status: 'OPEN',
                  summary: action.description,
                  startedAt: action.startedAt,
                  resolvedAt: null,
                },
                monitor: { id: claim.monitor.id, name: current!.name },
                ownerId: current!.ownerId,
              },
              now(),
            );
          } else if (action.kind === 'resolve') {
            Object.assign(active!, {
              status: 'RESOLVED',
              resolvedAt: action.resolvedAt,
              resolvedByCheckId: action.resolvedByCheckId,
              updatedAt: at,
            });
            const resolvedEventId = randomUUID();
            repo.incidentEvents.push({
              id: resolvedEventId,
              incidentId: action.incidentId,
              eventType: 'INCIDENT_RESOLVED',
              actorId: null,
              occurredAt: action.resolvedAt,
              description: action.eventDescription,
              checkId: action.resolvedByCheckId,
              createdAt: at,
            });
            incident = incidentOutcome(action, action.incidentId);
            notificationsQueued = enqueueInMemory(
              repo,
              {
                eventId: resolvedEventId,
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
              },
              now(),
            );
          }
        }
        Object.assign(current!, plan.update);
      } catch (err) {
        repo.checks = snapshot.checks;
        repo.incidents = snapshot.incidents;
        repo.incidentEvents = snapshot.incidentEvents;
        repo.notificationDeliveries = snapshot.notificationDeliveries;
        Object.assign(current!, snapshot.monitor);
        throw err;
      }
      return {
        recorded: true,
        status: current!.currentStatus as MonitorStatus,
        statusChanged: plan.transition?.statusChanged ?? false,
        healthSkipped: plan.healthSkipped,
        incident,
        notificationsQueued,
      };
    },

    async release(claim) {
      calls.release++;
      maybeFail('release');
      const current = find(claim.monitor.id);
      const plan = planRelease(current, claim, now());
      if (plan.kind === 'discard') return false;
      Object.assign(current!, plan.update);
      return true;
    },
  };
}
