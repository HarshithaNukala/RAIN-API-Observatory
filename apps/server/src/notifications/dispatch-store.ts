import { and, asc, eq, getTableColumns, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { authUsers } from 'drizzle-orm/supabase';
import type { Database } from '../db/client.js';
import {
  monitorNotificationSettings,
  notificationAttempts,
  notificationDeliveries,
  type MonitorNotificationSettingsRow,
  type NotificationDeliveryRow,
} from '../db/schema.js';
import type { CompletionDecision, DeliveryResult } from './notification-rules.js';

/** A delivery leased to this dispatcher. `attempts` already counts the attempt being made. */
export interface ClaimedDelivery {
  delivery: NotificationDeliveryRow;
  leaseToken: string;
}

export interface DeliveryContext {
  /** The owner's account address (EMAIL channel). */
  ownerEmail: string | null;
  /** The monitor's settings as they are now (WEBHOOK channel). */
  settings: MonitorNotificationSettingsRow | null;
}

export interface AttemptRecord {
  startedAt: Date;
  finishedAt: Date;
  result: DeliveryResult;
  decision: CompletionDecision;
}

export interface DispatchStore {
  /**
   * Leases up to `limit` deliveries: due PENDING rows, plus PROCESSING rows whose lease expired
   * (a dispatcher died mid-attempt). The attempt is counted at claim time, so attempts lost to
   * crashes still use up the retry budget. Expired leases that have no attempts left are marked
   * FAILED instead of being claimed again.
   */
  claim(limit: number, leaseSeconds: number): Promise<ClaimedDelivery[]>;
  loadContext(delivery: NotificationDeliveryRow): Promise<DeliveryContext>;
  /** Records the attempt and the new status if the lease is still ours. False when stale. */
  complete(claim: ClaimedDelivery, attempt: AttemptRecord): Promise<boolean>;
}

const LOST_ATTEMPT = 'The delivery attempt did not complete (the worker stopped during it)';

export function createDispatchStore(db: Database): DispatchStore {
  return {
    async claim(limit, leaseSeconds) {
      if (limit <= 0) return [];
      // Expired leases with no attempts left can't be retried: close them out first.
      await db
        .update(notificationDeliveries)
        .set({ status: 'FAILED', leaseUntil: null, leaseToken: null, lastError: LOST_ATTEMPT })
        .where(
          and(
            eq(notificationDeliveries.status, 'PROCESSING'),
            lt(notificationDeliveries.leaseUntil, sql`now()`),
            gte(notificationDeliveries.attempts, notificationDeliveries.maxAttempts),
          ),
        );

      const candidates = db.$with('candidates').as(
        db
          .select({ id: notificationDeliveries.id })
          .from(notificationDeliveries)
          .where(
            or(
              and(
                eq(notificationDeliveries.status, 'PENDING'),
                lte(notificationDeliveries.nextAttemptAt, sql`now()`),
              ),
              and(
                eq(notificationDeliveries.status, 'PROCESSING'),
                lt(notificationDeliveries.leaseUntil, sql`now()`),
                lt(notificationDeliveries.attempts, notificationDeliveries.maxAttempts),
              ),
            ),
          )
          .orderBy(asc(notificationDeliveries.nextAttemptAt))
          .limit(limit)
          .for('update', { skipLocked: true }),
      );
      const rows = await db
        .with(candidates)
        .update(notificationDeliveries)
        .set({
          status: 'PROCESSING',
          leaseToken: sql`gen_random_uuid()`,
          leaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
          attempts: sql`${notificationDeliveries.attempts} + 1`,
          lastAttemptedAt: sql`now()`,
        })
        .where(
          inArray(notificationDeliveries.id, db.select({ id: candidates.id }).from(candidates)),
        )
        .returning(getTableColumns(notificationDeliveries));
      return rows.map((delivery) => ({ delivery, leaseToken: delivery.leaseToken! }));
    },

    async loadContext(delivery) {
      if (delivery.channel === 'EMAIL') {
        const [owner] = await db
          .select({ email: authUsers.email })
          .from(authUsers)
          .where(eq(authUsers.id, delivery.ownerId));
        return { ownerEmail: owner?.email ?? null, settings: null };
      }
      const [settings] = await db
        .select()
        .from(monitorNotificationSettings)
        .where(
          and(
            eq(monitorNotificationSettings.monitorId, delivery.monitorId),
            eq(monitorNotificationSettings.ownerId, delivery.ownerId),
          ),
        );
      return { ownerEmail: null, settings: settings ?? null };
    },

    complete(claim, attempt) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ leaseToken: notificationDeliveries.leaseToken })
          .from(notificationDeliveries)
          .where(eq(notificationDeliveries.id, claim.delivery.id))
          .for('update');
        // Deleted (monitor removed) or re-claimed after our lease expired: write nothing.
        if (!locked || locked.leaseToken !== claim.leaseToken) return false;
        const { result, decision } = attempt;
        await tx
          .insert(notificationAttempts)
          .values({
            deliveryId: claim.delivery.id,
            attemptNumber: claim.delivery.attempts,
            startedAt: attempt.startedAt,
            finishedAt: attempt.finishedAt,
            outcome: result.outcome,
            httpStatus: result.httpStatus,
            error: result.outcome === 'SUCCESS' ? null : result.error,
          })
          .onConflictDoNothing({
            target: [notificationAttempts.deliveryId, notificationAttempts.attemptNumber],
          });
        await tx
          .update(notificationDeliveries)
          .set({
            status: decision.status,
            nextAttemptAt: decision.nextAttemptAt,
            lastError: decision.lastError,
            deliveredAt: decision.status === 'SENT' ? decision.deliveredAt : null,
            leaseUntil: null,
            leaseToken: null,
          })
          .where(
            and(
              eq(notificationDeliveries.id, claim.delivery.id),
              eq(notificationDeliveries.leaseToken, claim.leaseToken),
            ),
          );
        return true;
      });
    },
  };
}
