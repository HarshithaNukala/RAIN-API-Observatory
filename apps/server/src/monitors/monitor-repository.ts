import type { MonitorCheckSource, MonitorStatus } from '@rain/shared';
import { and, count, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import {
  monitorChecks,
  monitorHeaders,
  monitors,
  profiles,
  type MonitorCheckRow,
  type MonitorHeaderRow,
  type MonitorRow,
} from '../db/schema.js';
import type { PageCursor } from './cursor.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

export interface MonitorFilters {
  search?: string | undefined;
  enabled?: boolean | undefined;
  status?: MonitorStatus | undefined;
}

export interface CheckListOptions {
  source?: MonitorCheckSource | undefined;
  limit: number;
  /** Position of the last check on the previous page, in (checked_at DESC, id DESC) order. */
  after?: { checkedAt: Date; id: string } | undefined;
}

export type NewMonitorRow = typeof monitors.$inferInsert;
export type NewMonitorHeaderRow = typeof monitorHeaders.$inferInsert;
export type MonitorChanges = Partial<Omit<NewMonitorRow, 'id' | 'ownerId' | 'createdAt'>>;
/** List rows deliberately leave out the encrypted request body. */
export type MonitorSummaryRow = Omit<
  MonitorRow,
  'requestBodyCiphertext' | 'requestBodyIv' | 'requestBodyAuthTag' | 'requestBodyKeyVersion'
>;

const summaryColumns = {
  id: monitors.id,
  ownerId: monitors.ownerId,
  name: monitors.name,
  description: monitors.description,
  url: monitors.url,
  method: monitors.method,
  expectedStatusCode: monitors.expectedStatusCode,
  timeoutMs: monitors.timeoutMs,
  latencyThresholdMs: monitors.latencyThresholdMs,
  checkIntervalSeconds: monitors.checkIntervalSeconds,
  allowMutatingRequests: monitors.allowMutatingRequests,
  bodyContentType: monitors.bodyContentType,
  enabled: monitors.enabled,
  currentStatus: monitors.currentStatus,
  consecutiveFailures: monitors.consecutiveFailures,
  consecutiveSuccesses: monitors.consecutiveSuccesses,
  statusChangedAt: monitors.statusChangedAt,
  lastCheckedAt: monitors.lastCheckedAt,
  nextCheckAt: monitors.nextCheckAt,
  leaseUntil: monitors.leaseUntil,
  leaseToken: monitors.leaseToken,
  manualCheckRequestedAt: monitors.manualCheckRequestedAt,
  lastManualCheckAt: monitors.lastManualCheckAt,
  createdAt: monitors.createdAt,
  updatedAt: monitors.updatedAt,
};

const escapeLike = (term: string) => term.replace(/[\\%_]/g, '\\$&');

/**
 * All SQL for monitors. Every statement is scoped by `ownerId`: there is no way to read or
 * change a monitor (or its headers) through this module without naming its owner.
 */
function queries(db: Executor) {
  const owned = (ownerId: string, monitorId: string) =>
    and(eq(monitors.id, monitorId), eq(monitors.ownerId, ownerId));

  /** Header statements reach their monitor through this owner-checked subquery. */
  const ownedMonitorId = (ownerId: string, monitorId: string) =>
    db.select({ id: monitors.id }).from(monitors).where(owned(ownerId, monitorId));

  const matching = (ownerId: string, filters: MonitorFilters): SQL[] => {
    const conditions: SQL[] = [eq(monitors.ownerId, ownerId)];
    if (filters.search) conditions.push(ilike(monitors.name, `%${escapeLike(filters.search)}%`));
    if (filters.enabled !== undefined) conditions.push(eq(monitors.enabled, filters.enabled));
    if (filters.status) conditions.push(eq(monitors.currentStatus, filters.status));
    return conditions;
  };

  return {
    /** Serialises quota checks: concurrent creates by one user queue on their profile row. */
    async lockOwner(ownerId: string): Promise<void> {
      await db
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, ownerId))
        .for('update');
    },

    async countByOwner(ownerId: string, filters: MonitorFilters = {}): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(monitors)
        .where(and(...matching(ownerId, filters)));
      return row?.value ?? 0;
    },

    async insert(values: NewMonitorRow): Promise<MonitorRow> {
      const [row] = await db.insert(monitors).values(values).returning();
      if (!row) throw new Error('Monitor insert returned no row');
      return row;
    },

    async findById(
      ownerId: string,
      monitorId: string,
      options: { forUpdate?: boolean } = {},
    ): Promise<MonitorRow | undefined> {
      const query = db.select().from(monitors).where(owned(ownerId, monitorId)).limit(1);
      const [row] = await (options.forUpdate ? query.for('update') : query);
      return row;
    },

    /** Newest first. Fetch `limit + 1` to learn whether another page exists. */
    list(
      ownerId: string,
      filters: MonitorFilters,
      limit: number,
      after?: PageCursor,
    ): Promise<MonitorSummaryRow[]> {
      const conditions = matching(ownerId, filters);
      if (after) {
        const older = or(
          lt(monitors.createdAt, after.createdAt),
          and(eq(monitors.createdAt, after.createdAt), lt(monitors.id, after.id)),
        );
        if (older) conditions.push(older);
      }
      return db
        .select(summaryColumns)
        .from(monitors)
        .where(and(...conditions))
        .orderBy(desc(monitors.createdAt), desc(monitors.id))
        .limit(limit);
    },

    async update(
      ownerId: string,
      monitorId: string,
      changes: MonitorChanges,
    ): Promise<MonitorRow | undefined> {
      const [row] = await db
        .update(monitors)
        .set(changes)
        .where(owned(ownerId, monitorId))
        .returning();
      return row;
    },

    async delete(ownerId: string, monitorId: string): Promise<boolean> {
      const rows = await db
        .delete(monitors)
        .where(owned(ownerId, monitorId))
        .returning({ id: monitors.id });
      return rows.length > 0;
    },

    listHeaders(ownerId: string, monitorId: string): Promise<MonitorHeaderRow[]> {
      return db
        .select()
        .from(monitorHeaders)
        .where(inArray(monitorHeaders.monitorId, ownedMonitorId(ownerId, monitorId)))
        .orderBy(sql`lower(${monitorHeaders.headerName})`);
    },

    /** A monitor's checks, newest first. Fetch `limit + 1` to learn whether another page exists. */
    listChecks(
      ownerId: string,
      monitorId: string,
      options: CheckListOptions,
    ): Promise<MonitorCheckRow[]> {
      const conditions: SQL[] = [
        inArray(monitorChecks.monitorId, ownedMonitorId(ownerId, monitorId)),
      ];
      if (options.source) conditions.push(eq(monitorChecks.source, options.source));
      const { after } = options;
      if (after) {
        const older = or(
          lt(monitorChecks.checkedAt, after.checkedAt),
          and(eq(monitorChecks.checkedAt, after.checkedAt), lt(monitorChecks.id, after.id)),
        );
        if (older) conditions.push(older);
      }
      return db
        .select()
        .from(monitorChecks)
        .where(and(...conditions))
        .orderBy(desc(monitorChecks.checkedAt), desc(monitorChecks.id))
        .limit(options.limit);
    },

    async insertHeaders(rows: NewMonitorHeaderRow[]): Promise<void> {
      if (rows.length > 0) await db.insert(monitorHeaders).values(rows);
    },

    async replaceHeader(
      ownerId: string,
      monitorId: string,
      headerId: string,
      values: Pick<
        NewMonitorHeaderRow,
        'headerName' | 'valueCiphertext' | 'valueIv' | 'valueAuthTag' | 'encryptionKeyVersion'
      >,
    ): Promise<void> {
      await db
        .update(monitorHeaders)
        .set(values)
        .where(
          and(
            eq(monitorHeaders.id, headerId),
            inArray(monitorHeaders.monitorId, ownedMonitorId(ownerId, monitorId)),
          ),
        );
    },

    async deleteHeaders(ownerId: string, monitorId: string, headerIds: string[]): Promise<void> {
      if (headerIds.length === 0) return;
      await db
        .delete(monitorHeaders)
        .where(
          and(
            inArray(monitorHeaders.id, headerIds),
            inArray(monitorHeaders.monitorId, ownedMonitorId(ownerId, monitorId)),
          ),
        );
    },
  };
}

export type MonitorQueries = ReturnType<typeof queries>;

export interface MonitorRepository extends MonitorQueries {
  /** Runs `work` in one database transaction; any thrown error rolls everything back. */
  transaction<T>(
    work: (tx: MonitorQueries) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T>;
}

export function createMonitorRepository(db: Database): MonitorRepository {
  return {
    ...queries(db),
    transaction: (work, config) => db.transaction((tx) => work(queries(tx)), config),
  };
}
