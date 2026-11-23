import type {
  Incident,
  IncidentCounts,
  IncidentEvent,
  IncidentEventList,
  IncidentEventListQuery,
  IncidentEventType,
  IncidentList,
  IncidentListQuery,
  IncidentSeverity,
  IncidentStatus,
  UpdateIncident,
} from '@rain/shared';
import type { IncidentEventRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import { decodeCursor, encodeCursor } from '../monitors/cursor.js';
import type {
  IncidentChanges,
  IncidentRepository,
  IncidentWithMonitor,
} from './incident-repository.js';

export interface IncidentService {
  list(ownerId: string, query: IncidentListQuery): Promise<IncidentList>;
  counts(ownerId: string, monitorId?: string): Promise<IncidentCounts>;
  get(ownerId: string, incidentId: string): Promise<Incident>;
  events(
    ownerId: string,
    incidentId: string,
    query: IncidentEventListQuery,
  ): Promise<IncidentEventList>;
  acknowledge(ownerId: string, incidentId: string): Promise<Incident>;
  update(ownerId: string, incidentId: string, patch: UpdateIncident): Promise<Incident>;
}

export interface IncidentServiceDependencies {
  repository: IncidentRepository;
  now?: () => Date;
}

/** Same answer for "doesn't exist" and "someone else's", so incident IDs can't be probed. */
export const incidentNotFound = () => new AppError(404, 'INCIDENT_NOT_FOUND', 'Incident not found');

function toIncident({ incident: i, monitor }: IncidentWithMonitor): Incident {
  return {
    id: i.id,
    monitor,
    title: i.title,
    description: i.description,
    severity: i.severity as IncidentSeverity,
    status: i.status as IncidentStatus,
    startedAt: i.startedAt.toISOString(),
    acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: i.acknowledgedBy,
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    triggerCheckId: i.triggerCheckId,
    resolvedByCheckId: i.resolvedByCheckId,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

function toEvent(e: IncidentEventRow): IncidentEvent {
  return {
    id: e.id,
    type: e.eventType as IncidentEventType,
    occurredAt: e.occurredAt.toISOString(),
    actor: e.actorId ? 'USER' : 'SYSTEM',
    actorId: e.actorId,
    description: e.description,
    checkId: e.checkId,
  };
}

/** Says what changed without echoing the owner's text into the permanent record. */
function describeChanges(
  before: IncidentWithMonitor['incident'],
  changes: IncidentChanges,
): string {
  const parts: string[] = [];
  if (changes.severity !== undefined) {
    parts.push(`Severity changed from ${before.severity} to ${changes.severity}`);
  }
  if (changes.title !== undefined) parts.push('Title changed');
  if (changes.description !== undefined) {
    parts.push(changes.description === null ? 'Description removed' : 'Description updated');
  }
  return `${parts.join('. ')}.`;
}

export function createIncidentService(deps: IncidentServiceDependencies): IncidentService {
  const { repository } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(ownerId: string, incidentId: string) {
    const found = await repository.findById(ownerId, incidentId);
    if (!found) throw incidentNotFound();
    return found;
  }

  return {
    async list(ownerId, query) {
      const filters = {
        status: query.status,
        severity: query.severity,
        monitorId: query.monitorId,
      };
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      // One snapshot, so the page and the total agree.
      const { rows, total } = await repository.transaction(
        async (tx) => ({
          rows: await tx.list(
            ownerId,
            filters,
            query.limit + 1,
            cursor && { startedAt: cursor.createdAt, id: cursor.id },
          ),
          total: await tx.count(ownerId, filters),
        }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toIncident),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.incident.startedAt, id: last.incident.id })
            : null,
        total,
      };
    },

    async counts(ownerId, monitorId) {
      const rows = await repository.countByStatus(ownerId, monitorId);
      const of = (status: IncidentStatus) => rows.find((r) => r.status === status)?.value ?? 0;
      const open = of('OPEN');
      const acknowledged = of('ACKNOWLEDGED');
      const resolved = of('RESOLVED');
      return { total: open + acknowledged + resolved, open, acknowledged, resolved };
    },

    get: async (ownerId, incidentId) => toIncident(await load(ownerId, incidentId)),

    async events(ownerId, incidentId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const { found, rows } = await repository.transaction(
        async (tx) => ({
          found: await tx.findById(ownerId, incidentId),
          rows: await tx.listEvents(
            ownerId,
            incidentId,
            query.limit + 1,
            cursor && { occurredAt: cursor.createdAt, id: cursor.id },
          ),
        }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      if (!found) throw incidentNotFound();
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toEvent),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.occurredAt, id: last.id })
            : null,
      };
    },

    async acknowledge(ownerId, incidentId) {
      return repository.transaction(async (tx) => {
        // The row lock serialises this with concurrent acknowledgements and with the worker
        // resolving the incident, so the status check below can't go stale.
        const found = await tx.findById(ownerId, incidentId, { forUpdate: true });
        if (!found) throw incidentNotFound();
        const { incident } = found;
        if (incident.status === 'RESOLVED') {
          throw new AppError(
            409,
            'INCIDENT_ALREADY_RESOLVED',
            'This incident is already resolved and can no longer be acknowledged.',
          );
        }
        if (incident.status === 'ACKNOWLEDGED') {
          throw new AppError(
            409,
            'INCIDENT_ALREADY_ACKNOWLEDGED',
            'This incident has already been acknowledged.',
          );
        }
        const at = now();
        const updated = await tx.update(ownerId, incidentId, {
          status: 'ACKNOWLEDGED',
          acknowledgedAt: at,
          acknowledgedBy: ownerId,
        });
        if (!updated) throw incidentNotFound();
        await tx.insertEvent(ownerId, {
          incidentId,
          eventType: 'INCIDENT_ACKNOWLEDGED',
          actorId: ownerId,
          occurredAt: at,
          description: 'Incident acknowledged by the monitor owner.',
        });
        return toIncident({ incident: updated, monitor: found.monitor });
      });
    },

    async update(ownerId, incidentId, patch) {
      return repository.transaction(async (tx) => {
        const found = await tx.findById(ownerId, incidentId, { forUpdate: true });
        if (!found) throw incidentNotFound();
        const { incident } = found;
        // Only real changes are written and recorded.
        const changes: IncidentChanges = {
          ...(patch.title !== undefined &&
            patch.title !== incident.title && { title: patch.title }),
          ...(patch.description !== undefined &&
            patch.description !== incident.description && { description: patch.description }),
          ...(patch.severity !== undefined &&
            patch.severity !== incident.severity && { severity: patch.severity }),
        };
        if (Object.keys(changes).length === 0) return toIncident(found);

        const updated = await tx.update(ownerId, incidentId, changes);
        if (!updated) throw incidentNotFound();
        await tx.insertEvent(ownerId, {
          incidentId,
          eventType: 'INCIDENT_UPDATED',
          actorId: ownerId,
          occurredAt: now(),
          description: describeChanges(incident, changes),
        });
        return toIncident({ incident: updated, monitor: found.monitor });
      });
    },
  };
}
