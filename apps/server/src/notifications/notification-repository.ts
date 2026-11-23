import type { NotificationChannel, NotificationStatus } from '@rain/shared';
import { and, asc, count, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client.js';
import {
  incidents,
  monitorNotificationSettings,
  monitors,
  notificationAttempts,
  notificationDeliveries,
  type MonitorNotificationSettingsRow,
  type NewMonitorNotificationSettingsRow,
  type NotificationAttemptRow,
  type NotificationDeliveryRow,
} from '../db/schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

export interface DeliveryFilters {
  status?: NotificationStatus | undefined;
  channel?: NotificationChannel | undefined;
  monitorId?: string | undefined;
}

export interface DeliveryWithNames {
  delivery: NotificationDeliveryRow;
  monitorName: string;
  incidentTitle: string;
}

export type DeliveryChanges = Partial<
  Pick<NotificationDeliveryRow, 'status' | 'nextAttemptAt' | 'maxAttempts'>
>;

/**
 * All SQL for notification settings and history. Every statement is scoped by owner; incidents
 * and deliveries are only created by the worker (inside the check-completion transaction).
 */
function queries(db: Executor) {
  const matching = (ownerId: string, f: DeliveryFilters): SQL[] => {
    const c: SQL[] = [eq(notificationDeliveries.ownerId, ownerId)];
    if (f.status) c.push(eq(notificationDeliveries.status, f.status));
    if (f.channel) c.push(eq(notificationDeliveries.channel, f.channel));
    if (f.monitorId) c.push(eq(notificationDeliveries.monitorId, f.monitorId));
    return c;
  };
  const withNames = {
    delivery: notificationDeliveries,
    monitorName: monitors.name,
    incidentTitle: incidents.title,
  };

  return {
    async findMonitor(ownerId: string, monitorId: string) {
      const [row] = await db
        .select({ id: monitors.id, name: monitors.name })
        .from(monitors)
        .where(and(eq(monitors.id, monitorId), eq(monitors.ownerId, ownerId)));
      return row;
    },

    async getSettings(
      ownerId: string,
      monitorId: string,
      options: { forUpdate?: boolean } = {},
    ): Promise<MonitorNotificationSettingsRow | undefined> {
      const query = db
        .select()
        .from(monitorNotificationSettings)
        .where(
          and(
            eq(monitorNotificationSettings.monitorId, monitorId),
            eq(monitorNotificationSettings.ownerId, ownerId),
          ),
        );
      const [row] = await (options.forUpdate ? query.for('update') : query);
      return row;
    },

    /** Insert or replace a monitor's settings (the caller has verified ownership). */
    async saveSettings(
      values: NewMonitorNotificationSettingsRow,
    ): Promise<MonitorNotificationSettingsRow> {
      const { monitorId: _m, ownerId: _o, ...changes } = values;
      const [row] = await db
        .insert(monitorNotificationSettings)
        .values(values)
        .onConflictDoUpdate({ target: monitorNotificationSettings.monitorId, set: changes })
        .returning();
      return row!;
    },

    async listDeliveries(
      ownerId: string,
      filters: DeliveryFilters,
      limit: number,
      after?: { createdAt: Date; id: string },
    ): Promise<DeliveryWithNames[]> {
      const conditions = matching(ownerId, filters);
      if (after) {
        const older = or(
          lt(notificationDeliveries.createdAt, after.createdAt),
          and(
            eq(notificationDeliveries.createdAt, after.createdAt),
            lt(notificationDeliveries.id, after.id),
          ),
        );
        if (older) conditions.push(older);
      }
      return db
        .select(withNames)
        .from(notificationDeliveries)
        .innerJoin(monitors, eq(monitors.id, notificationDeliveries.monitorId))
        .innerJoin(incidents, eq(incidents.id, notificationDeliveries.incidentId))
        .where(and(...conditions))
        .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
        .limit(limit);
    },

    async countDeliveries(ownerId: string, filters: DeliveryFilters): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(notificationDeliveries)
        .where(and(...matching(ownerId, filters)));
      return row?.value ?? 0;
    },

    async findDelivery(
      ownerId: string,
      id: string,
      options: { forUpdate?: boolean } = {},
    ): Promise<DeliveryWithNames | undefined> {
      const query = db
        .select(withNames)
        .from(notificationDeliveries)
        .innerJoin(monitors, eq(monitors.id, notificationDeliveries.monitorId))
        .innerJoin(incidents, eq(incidents.id, notificationDeliveries.incidentId))
        .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.ownerId, ownerId)));
      const [row] = await (options.forUpdate
        ? query.for('update', { of: notificationDeliveries })
        : query);
      return row;
    },

    listAttempts(ownerId: string, deliveryId: string): Promise<NotificationAttemptRow[]> {
      return db
        .select(getAttemptColumns())
        .from(notificationAttempts)
        .innerJoin(
          notificationDeliveries,
          eq(notificationDeliveries.id, notificationAttempts.deliveryId),
        )
        .where(
          and(
            eq(notificationAttempts.deliveryId, deliveryId),
            eq(notificationDeliveries.ownerId, ownerId),
          ),
        )
        .orderBy(asc(notificationAttempts.attemptNumber));
    },

    async updateDelivery(
      ownerId: string,
      id: string,
      changes: DeliveryChanges,
    ): Promise<NotificationDeliveryRow | undefined> {
      const [row] = await db
        .update(notificationDeliveries)
        .set(changes)
        .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.ownerId, ownerId)))
        .returning();
      return row;
    },
  };
}

function getAttemptColumns() {
  return {
    id: notificationAttempts.id,
    deliveryId: notificationAttempts.deliveryId,
    attemptNumber: notificationAttempts.attemptNumber,
    startedAt: notificationAttempts.startedAt,
    finishedAt: notificationAttempts.finishedAt,
    outcome: notificationAttempts.outcome,
    httpStatus: notificationAttempts.httpStatus,
    error: notificationAttempts.error,
  };
}

export type NotificationQueries = ReturnType<typeof queries>;

export interface NotificationRepository extends NotificationQueries {
  transaction<T>(
    work: (tx: NotificationQueries) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T>;
}

export function createNotificationRepository(db: Database): NotificationRepository {
  return {
    ...queries(db),
    transaction: (work, config) => db.transaction((tx) => work(queries(tx)), config),
  };
}
