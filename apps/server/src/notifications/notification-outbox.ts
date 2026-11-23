import { eq } from 'drizzle-orm';
import { authUsers } from 'drizzle-orm/supabase';
import type { Database } from '../db/client.js';
import { monitorNotificationSettings, notificationDeliveries } from '../db/schema.js';
import { planDeliveries, type IncidentEventSnapshot } from './notification-rules.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Queues the notifications for one incident event INSIDE the caller's transaction (the worker's
 * check-completion transaction). Nothing is sent here: the dispatcher delivers the rows later.
 * `(event_id, channel)` is unique, so a retried or duplicated event queues nothing twice.
 * Returns the number of deliveries queued.
 */
export async function enqueueIncidentNotifications(
  tx: Transaction,
  event: IncidentEventSnapshot,
): Promise<number> {
  const [settings] = await tx
    .select()
    .from(monitorNotificationSettings)
    .where(eq(monitorNotificationSettings.monitorId, event.monitor.id));
  if (!settings || (!settings.emailEnabled && !settings.webhookEnabled)) return 0;
  // The owner's account address (Supabase auth). Read here, never stored in plain form.
  const [owner] = settings.emailEnabled
    ? await tx
        .select({ email: authUsers.email })
        .from(authUsers)
        .where(eq(authUsers.id, event.ownerId))
    : [];
  const rows = planDeliveries(settings, owner?.email ?? null, event);
  if (rows.length === 0) return 0;
  const inserted = await tx
    .insert(notificationDeliveries)
    .values(rows)
    .onConflictDoNothing({
      target: [notificationDeliveries.eventId, notificationDeliveries.channel],
    })
    .returning({ id: notificationDeliveries.id });
  return inserted.length;
}
