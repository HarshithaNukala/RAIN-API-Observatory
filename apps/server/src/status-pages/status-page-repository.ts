import {
  HEALTH_NEUTRAL_REASONS,
  type IncidentSeverity,
  type IncidentStatus,
  type MonitorStatus,
} from '@rain/shared';
import { and, asc, count, desc, eq, gte, inArray, ne, or, sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import {
  incidents,
  monitorChecks,
  monitors,
  profiles,
  statusPageMonitors,
  statusPages,
  type NewStatusPageRow,
  type StatusPageRow,
} from '../db/schema.js';
import type { DayCounts } from './public-status.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

export interface PageMonitorRow {
  monitorId: string;
  monitorName: string;
  displayName: string;
  position: number;
  currentStatus: MonitorStatus;
  enabled: boolean;
  lastCheckedAt: Date | null;
}

export interface PublicIncidentRow {
  monitorId: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  startedAt: Date;
  resolvedAt: Date | null;
}

export type StatusPageChanges = Partial<
  Pick<
    NewStatusPageRow,
    'title' | 'description' | 'slug' | 'published' | 'publishedAt' | 'updatedAt'
  >
>;

const NEUTRAL = sql.raw([...HEALTH_NEUTRAL_REASONS].map((r) => `'${r}'`).join(', '));

/**
 * All SQL for status pages. Management statements are scoped by owner. The public statements read
 * only published pages, only the page's own monitors (re-checking that monitor and page share an
 * owner), and are bounded: at most 50 monitors, a 30-day window and a fixed incident limit.
 */
function queries(db: Executor) {
  const owned = (ownerId: string, id: string) =>
    and(eq(statusPages.id, id), eq(statusPages.ownerId, ownerId));

  const pageMonitorColumns = {
    monitorId: statusPageMonitors.monitorId,
    monitorName: monitors.name,
    displayName: statusPageMonitors.displayName,
    position: statusPageMonitors.position,
    currentStatus: monitors.currentStatus,
    enabled: monitors.enabled,
    lastCheckedAt: monitors.lastCheckedAt,
  };

  return {
    /** Serialises quota checks for one owner (same approach as monitors). */
    async lockOwner(ownerId: string): Promise<void> {
      await db
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, ownerId))
        .for('update');
    },

    async countByOwner(ownerId: string): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(statusPages)
        .where(eq(statusPages.ownerId, ownerId));
      return row?.value ?? 0;
    },

    async listByOwner(ownerId: string): Promise<Array<StatusPageRow & { monitorCount: number }>> {
      const rows = await db
        .select({
          page: statusPages,
          monitorCount: sql<number>`(SELECT count(*)::int FROM ${statusPageMonitors} WHERE ${statusPageMonitors.statusPageId} = ${statusPages.id})`,
        })
        .from(statusPages)
        .where(eq(statusPages.ownerId, ownerId))
        .orderBy(desc(statusPages.createdAt), desc(statusPages.id));
      return rows.map((r) => ({ ...r.page, monitorCount: Number(r.monitorCount) }));
    },

    async findById(
      ownerId: string,
      id: string,
      options: { forUpdate?: boolean } = {},
    ): Promise<StatusPageRow | undefined> {
      const query = db.select().from(statusPages).where(owned(ownerId, id));
      const [row] = await (options.forUpdate ? query.for('update') : query);
      return row;
    },

    async slugExists(slug: string, exceptId?: string): Promise<boolean> {
      const [row] = await db
        .select({ id: statusPages.id })
        .from(statusPages)
        .where(
          exceptId
            ? and(eq(statusPages.slug, slug), ne(statusPages.id, exceptId))
            : eq(statusPages.slug, slug),
        );
      return row !== undefined;
    },

    async insert(values: NewStatusPageRow): Promise<StatusPageRow> {
      const [row] = await db.insert(statusPages).values(values).returning();
      return row!;
    },

    async update(
      ownerId: string,
      id: string,
      changes: StatusPageChanges,
    ): Promise<StatusPageRow | undefined> {
      const [row] = await db.update(statusPages).set(changes).where(owned(ownerId, id)).returning();
      return row;
    },

    async delete(ownerId: string, id: string): Promise<boolean> {
      const rows = await db
        .delete(statusPages)
        .where(owned(ownerId, id))
        .returning({ id: statusPages.id });
      return rows.length > 0;
    },

    /** The page's monitors in display order (the page must already be known to be owned). */
    listMonitors(pageId: string): Promise<PageMonitorRow[]> {
      return (
        db
          .select(pageMonitorColumns)
          .from(statusPageMonitors)
          .innerJoin(statusPages, eq(statusPages.id, statusPageMonitors.statusPageId))
          // Defence in depth: only monitors of the page's own owner, whatever is in the table.
          .innerJoin(
            monitors,
            and(
              eq(monitors.id, statusPageMonitors.monitorId),
              eq(monitors.ownerId, statusPages.ownerId),
            ),
          )
          .where(eq(statusPageMonitors.statusPageId, pageId))
          .orderBy(asc(statusPageMonitors.position), asc(statusPageMonitors.createdAt)) as Promise<
          PageMonitorRow[]
        >
      );
    },

    async findOwnedMonitor(ownerId: string, monitorId: string) {
      const [row] = await db
        .select({ id: monitors.id, name: monitors.name })
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.ownerId, ownerId)));
      return row;
    },

    async insertMonitor(values: {
      statusPageId: string;
      monitorId: string;
      displayName: string;
      position: number;
    }) {
      await db.insert(statusPageMonitors).values(values);
    },

    async updateMonitor(
      pageId: string,
      monitorId: string,
      changes: { displayName?: string; position?: number },
    ): Promise<boolean> {
      const rows = await db
        .update(statusPageMonitors)
        .set(changes)
        .where(
          and(
            eq(statusPageMonitors.statusPageId, pageId),
            eq(statusPageMonitors.monitorId, monitorId),
          ),
        )
        .returning({ id: statusPageMonitors.monitorId });
      return rows.length > 0;
    },

    async deleteMonitor(pageId: string, monitorId: string): Promise<boolean> {
      const rows = await db
        .delete(statusPageMonitors)
        .where(
          and(
            eq(statusPageMonitors.statusPageId, pageId),
            eq(statusPageMonitors.monitorId, monitorId),
          ),
        )
        .returning({ id: statusPageMonitors.monitorId });
      return rows.length > 0;
    },

    // --- Public -------------------------------------------------------------------------------

    async findPublishedBySlug(slug: string): Promise<StatusPageRow | undefined> {
      const [row] = await db
        .select()
        .from(statusPages)
        .where(and(eq(statusPages.slug, slug), eq(statusPages.published, true)));
      return row;
    },

    /** Counted and successful checks per monitor per UTC day since `from` (≤ 50 × 30 rows). */
    async dayCounts(
      monitorIds: string[],
      from: Date,
    ): Promise<Array<DayCounts & { monitorId: string }>> {
      if (monitorIds.length === 0) return [];
      const eligible = sql`(${monitorChecks.failureReason} IS NULL OR ${monitorChecks.failureReason} NOT IN (${NEUTRAL}))`;
      const rows = await db
        .select({
          monitorId: monitorChecks.monitorId,
          dayMs: sql<number>`(extract(epoch from date_trunc('day', ${monitorChecks.checkedAt} AT TIME ZONE 'UTC')) * 1000)::float8`,
          eligible: sql<number>`count(*) FILTER (WHERE ${eligible})::int`,
          successful: sql<number>`count(*) FILTER (WHERE ${eligible} AND ${monitorChecks.outcome} <> 'FAILURE')::int`,
        })
        .from(monitorChecks)
        .where(
          and(inArray(monitorChecks.monitorId, monitorIds), gte(monitorChecks.checkedAt, from)),
        )
        .groupBy(monitorChecks.monitorId, sql`2`);
      return rows
        .map((r) => ({
          monitorId: r.monitorId,
          dayMs: Number(r.dayMs),
          eligible: Number(r.eligible),
          successful: Number(r.successful),
        }))
        .filter((r) => r.eligible > 0);
    },

    /** Recent and still-open incidents of these monitors, newest first, bounded. */
    publicIncidents(
      ownerId: string,
      monitorIds: string[],
      from: Date,
      limit: number,
    ): Promise<PublicIncidentRow[]> {
      if (monitorIds.length === 0) return Promise.resolve([]);
      return db
        .select({
          monitorId: incidents.monitorId,
          status: incidents.status,
          severity: incidents.severity,
          startedAt: incidents.startedAt,
          resolvedAt: incidents.resolvedAt,
        })
        .from(incidents)
        .where(
          and(
            eq(incidents.ownerId, ownerId),
            inArray(incidents.monitorId, monitorIds),
            or(gte(incidents.startedAt, from), ne(incidents.status, 'RESOLVED')),
          ),
        )
        .orderBy(desc(incidents.startedAt), desc(incidents.id))
        .limit(limit) as Promise<PublicIncidentRow[]>;
    },
  };
}

export type StatusPageQueries = ReturnType<typeof queries>;

export interface StatusPageRepository extends StatusPageQueries {
  transaction<T>(
    work: (tx: StatusPageQueries) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T>;
}

export function createStatusPageRepository(db: Database): StatusPageRepository {
  return {
    ...queries(db),
    transaction: (work, config) => db.transaction((tx) => work(queries(tx)), config),
  };
}
