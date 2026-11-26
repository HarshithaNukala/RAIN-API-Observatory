import { randomUUID } from 'node:crypto';
import type { MonitorStatus } from '@rain/shared';
import type { IncidentRow } from '../db/schema.js';
import type {
  IncidentAnalysisContext,
  IncidentCheckSummary,
  IncidentFilters,
  IncidentRepository,
  IncidentWithMonitor,
} from '../incidents/incident-repository.js';
import type { InMemoryMonitorRepository } from './in-memory-monitor-repository.js';

/**
 * Unit-test stand-in for the incident repository, on the same rows as an in-memory monitor
 * repository (so the worker's incidents are visible to the incident service). Same owner scoping,
 * filters, ordering and cursors as the SQL; transactions roll back on error. The SQL itself is
 * covered by tests/integration/incidents.test.ts.
 */
export function createInMemoryIncidentRepository(
  repo: InMemoryMonitorRepository,
): IncidentRepository {
  const matches = (i: IncidentRow, ownerId: string, f: IncidentFilters) =>
    i.ownerId === ownerId &&
    (!f.status || (f.status === 'ACTIVE' ? i.status !== 'RESOLVED' : i.status === f.status)) &&
    (!f.severity || i.severity === f.severity) &&
    (!f.monitorId || i.monitorId === f.monitorId);

  const join = (i: IncidentRow): IncidentWithMonitor | undefined => {
    const m = repo.monitors.find((x) => x.id === i.monitorId);
    return m
      ? {
          incident: { ...i },
          monitor: {
            id: m.id,
            name: m.name,
            currentStatus: m.currentStatus as MonitorStatus,
            enabled: m.enabled,
          },
        }
      : undefined;
  };

  const newestFirst = (a: IncidentRow, b: IncidentRow) =>
    b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  const owned = (ownerId: string, id: string) =>
    repo.incidents.find((i) => i.id === id && i.ownerId === ownerId);

  const self: IncidentRepository = {
    async list(ownerId, filters, limit, after) {
      return repo.incidents
        .filter(
          (i) =>
            matches(i, ownerId, filters) &&
            (!after ||
              i.startedAt.getTime() < after.startedAt.getTime() ||
              (i.startedAt.getTime() === after.startedAt.getTime() && i.id < after.id)),
        )
        .sort(newestFirst)
        .slice(0, limit)
        .map((i) => join(i)!)
        .filter(Boolean);
    },

    async count(ownerId, filters) {
      return repo.incidents.filter((i) => matches(i, ownerId, filters)).length;
    },

    async countByStatus(ownerId, monitorId) {
      const counts = new Map<string, number>();
      for (const i of repo.incidents.filter((x) => matches(x, ownerId, { monitorId }))) {
        counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
      }
      return [...counts].map(([status, value]) => ({ status, value }));
    },

    async findById(ownerId, incidentId) {
      const i = owned(ownerId, incidentId);
      return i && join(i);
    },

    async update(ownerId, incidentId, changes) {
      const i = owned(ownerId, incidentId);
      if (!i) return undefined;
      Object.assign(i, changes, { updatedAt: new Date() });
      return { ...i };
    },

    async insertEvent(ownerId, event) {
      if (!owned(ownerId, event.incidentId)) throw new Error('Incident not owned');
      repo.incidentEvents.push({
        id: event.id ?? randomUUID(),
        incidentId: event.incidentId,
        eventType: event.eventType,
        actorId: event.actorId ?? null,
        occurredAt: event.occurredAt,
        description: event.description,
        checkId: event.checkId ?? null,
        createdAt: new Date(),
      });
    },

    async listEvents(ownerId, incidentId, limit, after) {
      if (!owned(ownerId, incidentId)) return [];
      return repo.incidentEvents
        .filter(
          (e) =>
            e.incidentId === incidentId &&
            (!after ||
              e.occurredAt.getTime() > after.occurredAt.getTime() ||
              (e.occurredAt.getTime() === after.occurredAt.getTime() && e.id > after.id)),
        )
        .sort(
          (a, b) =>
            a.occurredAt.getTime() - b.occurredAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, limit)
        .map((e) => ({ ...e }));
    },

    async findAnalysisContext(ownerId, incidentId): Promise<IncidentAnalysisContext | undefined> {
      const i = owned(ownerId, incidentId);
      if (!i) return undefined;
      const m = repo.monitors.find((x) => x.id === i.monitorId && x.ownerId === ownerId);
      if (!m) return undefined;
      const toSummary = (c: (typeof repo.checks)[number]): IncidentCheckSummary => ({
        id: c.id,
        checkedAt: c.checkedAt,
        source: c.source,
        outcome: c.outcome,
        statusCode: c.statusCode,
        latencyMs: c.latencyMs,
        failureReason: c.failureReason,
        errorMessage: c.errorMessage,
      });
      const monitorChecksList = repo.checks
        .filter((c) => c.monitorId === m.id)
        .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
      const cutoff = i.startedAt.getTime() - 24 * 60 * 60 * 1000;
      const windowChecks = monitorChecksList.filter((c) => c.checkedAt.getTime() >= cutoff);
      const latencies = windowChecks.map((c) => c.latencyMs).filter((v): v is number => v !== null);
      return {
        incident: { ...i },
        monitor: {
          id: m.id,
          name: m.name,
          url: m.url,
          method: m.method,
          expectedStatusCode: m.expectedStatusCode,
          timeoutMs: m.timeoutMs,
          latencyThresholdMs: m.latencyThresholdMs,
          checkIntervalSeconds: m.checkIntervalSeconds,
          enabled: m.enabled,
          currentStatus: m.currentStatus as MonitorStatus,
          consecutiveFailures: m.consecutiveFailures,
          consecutiveSuccesses: m.consecutiveSuccesses,
        },
        triggerCheck: i.triggerCheckId
          ? (monitorChecksList.find((c) => c.id === i.triggerCheckId) ?? null) &&
            toSummary(monitorChecksList.find((c) => c.id === i.triggerCheckId)!)
          : null,
        resolvedByCheck: i.resolvedByCheckId
          ? (monitorChecksList.find((c) => c.id === i.resolvedByCheckId) ?? null) &&
            toSummary(monitorChecksList.find((c) => c.id === i.resolvedByCheckId)!)
          : null,
        recentChecks: monitorChecksList.slice(0, 15).map(toSummary),
        windowStats: {
          totalChecks: windowChecks.length,
          failedChecks: windowChecks.filter((c) => c.outcome === 'FAILURE').length,
          avgLatencyMs: latencies.length
            ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
            : null,
        },
      };
    },

    // Delegates to the monitor repository's transaction, which snapshots incidents and events.
    transaction: (work, _config) => repo.transaction(() => work(self)),
  };
  return self;
}
