import type { IncidentSeverity, IncidentStatusFilter, MonitorStatus } from '@rain/shared';
import { and, asc, count, desc, eq, gt, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import {
  incidentEvents,
  incidents,
  monitorChecks,
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

export interface IncidentCheckSummary {
  id: string;
  checkedAt: Date;
  source: string;
  outcome: string;
  statusCode: number | null;
  latencyMs: number | null;
  failureReason: string | null;
  errorMessage: string | null;
}

export interface IncidentAnalysisContext {
  incident: IncidentRow;
  monitor: {
    id: string;
    name: string;
    url: string;
    method: string;
    expectedStatusCode: number;
    timeoutMs: number;
    latencyThresholdMs: number;
    checkIntervalSeconds: number;
    enabled: boolean;
    currentStatus: MonitorStatus;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
  };
  triggerCheck: IncidentCheckSummary | null;
  resolvedByCheck: IncidentCheckSummary | null;
  recentChecks: IncidentCheckSummary[];
  windowStats: {
    totalChecks: number;
    failedChecks: number;
    avgLatencyMs: number | null;
  };
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

    /**
     * Multi-table SQL JOIN retrieving owner-scoped context for AI incident analysis:
     * joins `incidents` -> `monitors` -> `monitor_checks` (trigger check, resolution check,
     * and recent check history + aggregate stats). Never selects headers or encrypted bodies.
     */
    async findAnalysisContext(
      ownerId: string,
      incidentId: string,
    ): Promise<IncidentAnalysisContext | undefined> {
      const executeRows = async <T>(query: SQL): Promise<T[]> =>
        (await db.execute(query)) as unknown as T[];

      const [header] = await executeRows<Record<string, unknown>>(sql`
        SELECT
          i.id AS "incidentId",
          i.monitor_id AS "monitorId",
          i.owner_id AS "ownerId",
          i.title AS "title",
          i.description AS "description",
          i.severity AS "severity",
          i.status AS "status",
          i.started_at AS "startedAt",
          i.acknowledged_at AS "acknowledgedAt",
          i.acknowledged_by AS "acknowledgedBy",
          i.resolved_at AS "resolvedAt",
          i.trigger_check_id AS "triggerCheckId",
          i.resolved_by_check_id AS "resolvedByCheckId",
          i.created_at AS "createdAt",
          i.updated_at AS "updatedAt",
          m.name AS "monitorName",
          m.url AS "monitorUrl",
          m.method AS "monitorMethod",
          m.expected_status_code AS "expectedStatusCode",
          m.timeout_ms AS "timeoutMs",
          m.latency_threshold_ms AS "latencyThresholdMs",
          m.check_interval_seconds AS "checkIntervalSeconds",
          m.enabled AS "monitorEnabled",
          m.current_status AS "monitorCurrentStatus",
          m.consecutive_failures AS "consecutiveFailures",
          m.consecutive_successes AS "consecutiveSuccesses",
          tc.id AS "tcId",
          tc.checked_at AS "tcCheckedAt",
          tc.source AS "tcSource",
          tc.outcome AS "tcOutcome",
          tc.status_code AS "tcStatusCode",
          tc.latency_ms AS "tcLatencyMs",
          tc.failure_reason AS "tcFailureReason",
          tc.error_message AS "tcErrorMessage",
          rc.id AS "rcId",
          rc.checked_at AS "rcCheckedAt",
          rc.source AS "rcSource",
          rc.outcome AS "rcOutcome",
          rc.status_code AS "rcStatusCode",
          rc.latency_ms AS "rcLatencyMs",
          rc.failure_reason AS "rcFailureReason",
          rc.error_message AS "rcErrorMessage"
        FROM incidents i
        INNER JOIN monitors m ON m.id = i.monitor_id
        LEFT JOIN monitor_checks tc ON tc.id = i.trigger_check_id AND tc.monitor_id = m.id
        LEFT JOIN monitor_checks rc ON rc.id = i.resolved_by_check_id AND rc.monitor_id = m.id
        WHERE i.id = ${incidentId}
          AND i.owner_id = ${ownerId}
          AND m.owner_id = ${ownerId}
        LIMIT 1
      `);

      if (!header) return undefined;

      const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
      const toNullableDate = (v: unknown): Date | null =>
        v === null || v === undefined ? null : toDate(v);
      const toNullableInt = (v: unknown): number | null =>
        v === null || v === undefined ? null : Number(v);

      const parseCheck = (prefix: 'tc' | 'rc'): IncidentCheckSummary | null => {
        const id = header[`${prefix}Id`];
        if (!id) return null;
        return {
          id: String(id),
          checkedAt: toDate(header[`${prefix}CheckedAt`]),
          source: String(header[`${prefix}Source`]),
          outcome: String(header[`${prefix}Outcome`]),
          statusCode: toNullableInt(header[`${prefix}StatusCode`]),
          latencyMs: toNullableInt(header[`${prefix}LatencyMs`]),
          failureReason: header[`${prefix}FailureReason`]
            ? String(header[`${prefix}FailureReason`])
            : null,
          errorMessage: header[`${prefix}ErrorMessage`]
            ? String(header[`${prefix}ErrorMessage`])
            : null,
        };
      };

      const monitorId = String(header.monitorId);
      const recentCheckRows = await db
        .select({
          id: monitorChecks.id,
          checkedAt: monitorChecks.checkedAt,
          source: monitorChecks.source,
          outcome: monitorChecks.outcome,
          statusCode: monitorChecks.statusCode,
          latencyMs: monitorChecks.latencyMs,
          failureReason: monitorChecks.failureReason,
          errorMessage: monitorChecks.errorMessage,
        })
        .from(monitorChecks)
        .innerJoin(monitors, eq(monitors.id, monitorChecks.monitorId))
        .where(and(eq(monitors.ownerId, ownerId), eq(monitors.id, monitorId)))
        .orderBy(desc(monitorChecks.checkedAt))
        .limit(15);

      const [stats] = await executeRows<Record<string, unknown>>(sql`
        SELECT
          count(*)::int AS "totalChecks",
          count(*) FILTER (WHERE c.outcome = 'FAILURE')::int AS "failedChecks",
          avg(c.latency_ms)::float8 AS "avgLatencyMs"
        FROM monitor_checks c
        INNER JOIN monitors m ON m.id = c.monitor_id
        WHERE m.owner_id = ${ownerId}
          AND m.id = ${monitorId}
          AND c.checked_at >= ${toDate(header.startedAt).toISOString()}::timestamptz - interval '24 hours'
      `);

      return {
        incident: {
          id: String(header.incidentId),
          monitorId,
          ownerId: String(header.ownerId),
          title: String(header.title),
          description: header.description !== null ? String(header.description) : null,
          severity: String(header.severity),
          status: String(header.status),
          startedAt: toDate(header.startedAt),
          acknowledgedAt: toNullableDate(header.acknowledgedAt),
          acknowledgedBy: header.acknowledgedBy ? String(header.acknowledgedBy) : null,
          resolvedAt: toNullableDate(header.resolvedAt),
          triggerCheckId: header.triggerCheckId ? String(header.triggerCheckId) : null,
          resolvedByCheckId: header.resolvedByCheckId ? String(header.resolvedByCheckId) : null,
          createdAt: toDate(header.createdAt),
          updatedAt: toDate(header.updatedAt),
        },
        monitor: {
          id: monitorId,
          name: String(header.monitorName),
          url: String(header.monitorUrl),
          method: String(header.monitorMethod),
          expectedStatusCode: Number(header.expectedStatusCode),
          timeoutMs: Number(header.timeoutMs),
          latencyThresholdMs: Number(header.latencyThresholdMs),
          checkIntervalSeconds: Number(header.checkIntervalSeconds),
          enabled: Boolean(header.monitorEnabled),
          currentStatus: String(header.monitorCurrentStatus) as MonitorStatus,
          consecutiveFailures: Number(header.consecutiveFailures),
          consecutiveSuccesses: Number(header.consecutiveSuccesses),
        },
        triggerCheck: parseCheck('tc'),
        resolvedByCheck: parseCheck('rc'),
        recentChecks: recentCheckRows,
        windowStats: {
          totalChecks: Number(stats?.totalChecks ?? 0),
          failedChecks: Number(stats?.failedChecks ?? 0),
          avgLatencyMs:
            stats?.avgLatencyMs === null || stats?.avgLatencyMs === undefined
              ? null
              : Math.round(Number(stats.avgLatencyMs)),
        },
      };
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
