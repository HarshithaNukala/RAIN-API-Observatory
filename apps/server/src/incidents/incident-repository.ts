import type { IncidentSeverity, IncidentStatusFilter, MonitorStatus } from '@rain/shared';
import { and, asc, count, desc, eq, gt, inArray, lt, ne, or, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import {
  incidentEvents,
  incidents,
  monitors,
  type IncidentEventRow,
  type IncidentRow,
  type NewIncidentEventRow,
  type NewIncidentRow,
} from '../db/schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

export interface IncidentFilters {
  status?: IncidentStatusFilter | undefined;
  severity?: IncidentSeverity | undefined;
  monitorId?: string | undefined;
}

export interface IncidentMonitorRow {
  id: string;
  name: string;
  currentStatus: MonitorStatus;
  enabled: boolean;
}

export interface IncidentWithMonitor {
  incident: IncidentRow;
  monitor: IncidentMonitorRow;
}

export type IncidentChanges = Partial<
  Pick<
    NewIncidentRow,
    'title' | 'description' | 'severity' | 'status' | 'acknowledgedAt' | 'acknowledgedBy'
  >
>;

export interface IncidentStatusCount {
  status: string;
  value: number;
}

const monitorColumns = {
  id: monitors.id,
  name: monitors.name,
  currentStatus: monitors.currentStatus,
  enabled: monitors.enabled,
};

/**
 * All SQL for incidents. Every statement is scoped by `ownerId`: an incident, its events or its
 * monitor can't be read or changed through this module without naming the owner. Incidents are
 * only created and resolved by the monitoring store, inside the check-completion transaction.
 */
function queries(db: Executor) {
  const matching = (ownerId: string, filters: IncidentFilters): SQL[] => {
    const conditions: SQL[] = [eq(incidents.ownerId, ownerId)];
    if (filters.status === 'ACTIVE') conditions.push(ne(incidents.status, 'RESOLVED'));
    else if (filters.status) conditions.push(eq(incidents.status, filters.status));
    if (filters.severity) conditions.push(eq(incidents.severity, filters.severity));
    if (filters.monitorId) conditions.push(eq(incidents.monitorId, filters.monitorId));
    return conditions;
  };

  const withMonitor = (
    rows: Array<{
      incident: IncidentRow;
      monitor: Omit<IncidentMonitorRow, 'currentStatus'> & { currentStatus: string };
    }>,
  ) =>
    rows.map(({ incident, monitor }) => ({
      incident,
      monitor: { ...monitor, currentStatus: monitor.currentStatus as MonitorStatus },
    }));

  /** Event statements reach their incident through this owner-checked subquery. */
  const ownedIncidentId = (ownerId: string, incidentId: string) =>
    db
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(eq(incidents.id, incidentId), eq(incidents.ownerId, ownerId)));

  return {
    /** Newest first. Fetch `limit + 1` to learn whether another page exists. */
    async list(
      ownerId: string,
      filters: IncidentFilters,
      limit: number,
      after?: { startedAt: Date; id: string },
    ): Promise<IncidentWithMonitor[]> {
      const conditions = matching(ownerId, filters);
      if (after) {
        const older = or(
          lt(incidents.startedAt, after.startedAt),
          and(eq(incidents.startedAt, after.startedAt), lt(incidents.id, after.id)),
        );
        if (older) conditions.push(older);
      }
      const rows = await db
        .select({ incident: incidents, monitor: monitorColumns })
        .from(incidents)
        .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
        .where(and(...conditions))
        .orderBy(desc(incidents.startedAt), desc(incidents.id))
        .limit(limit);
      return withMonitor(rows);
    },

    async count(ownerId: string, filters: IncidentFilters): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(incidents)
        .where(and(...matching(ownerId, filters)));
      return row?.value ?? 0;
    },

    countByStatus(ownerId: string, monitorId?: string): Promise<IncidentStatusCount[]> {
      return db
        .select({ status: incidents.status, value: count() })
        .from(incidents)
        .where(and(...matching(ownerId, { monitorId })))
        .groupBy(incidents.status);
    },

    async findById(
      ownerId: string,
      incidentId: string,
      options: { forUpdate?: boolean } = {},
    ): Promise<IncidentWithMonitor | undefined> {
      const query = db
        .select({ incident: incidents, monitor: monitorColumns })
        .from(incidents)
        .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
        .where(and(eq(incidents.id, incidentId), eq(incidents.ownerId, ownerId)))
        .limit(1);
      // Lock only the incident row: the worker locks monitor → incident, never the other way.
      const rows = await (options.forUpdate ? query.for('update', { of: incidents }) : query);
      return withMonitor(rows)[0];
    },

    async update(
      ownerId: string,
      incidentId: string,
      changes: IncidentChanges,
    ): Promise<IncidentRow | undefined> {
      const [row] = await db
        .update(incidents)
        .set(changes)
        .where(and(eq(incidents.id, incidentId), eq(incidents.ownerId, ownerId)))
        .returning();
      return row;
    },

    /** Appends to an owned incident's timeline (the subquery makes a foreign incident a no-op). */
    async insertEvent(ownerId: string, event: NewIncidentEventRow): Promise<void> {
      const owned = await ownedIncidentId(ownerId, event.incidentId);
      if (owned.length === 0) throw new Error('Incident not owned');
      await db.insert(incidentEvents).values(event);
    },

    /** Oldest first. Fetch `limit + 1` to learn whether another page exists. */
    listEvents(
      ownerId: string,
      incidentId: string,
      limit: number,
      after?: { occurredAt: Date; id: string },
    ): Promise<IncidentEventRow[]> {
      const conditions: SQL[] = [
        inArray(incidentEvents.incidentId, ownedIncidentId(ownerId, incidentId)),
      ];
      if (after) {
        const newer = or(
          gt(incidentEvents.occurredAt, after.occurredAt),
          and(eq(incidentEvents.occurredAt, after.occurredAt), gt(incidentEvents.id, after.id)),
        );
        if (newer) conditions.push(newer);
      }
      return db
        .select()
        .from(incidentEvents)
        .where(and(...conditions))
        .orderBy(asc(incidentEvents.occurredAt), asc(incidentEvents.id))
        .limit(limit);
    },
  };
}

export type IncidentQueries = ReturnType<typeof queries>;

export interface IncidentRepository extends IncidentQueries {
  transaction<T>(
    work: (tx: IncidentQueries) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T>;
}

export function createIncidentRepository(db: Database): IncidentRepository {
  return {
    ...queries(db),
    transaction: (work, config) => db.transaction((tx) => work(queries(tx)), config),
  };
}
