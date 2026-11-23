import { randomUUID } from 'node:crypto';
import { NOTIFICATION_LIMITS } from '@rain/shared';
import type { NotificationDeliveryRow } from '../db/schema.js';
import { planDeliveries, type IncidentEventSnapshot } from '../notifications/notification-rules.js';
import type { InMemoryMonitorRepository } from './in-memory-monitor-repository.js';

/**
 * TEST ONLY. The in-memory twin of enqueueIncidentNotifications: same planning rules and the same
 * (event_id, channel) uniqueness. Called inside the in-memory store's "transaction".
 */
export function enqueueInMemory(
  repo: InMemoryMonitorRepository,
  event: IncidentEventSnapshot,
  at: Date = new Date(),
): number {
  const settings = repo.notificationSettings.find((s) => s.monitorId === event.monitor.id);
  const email = repo.ownerEmails.get(event.ownerId) ?? null;
  let queued = 0;
  for (const row of planDeliveries(settings, email, event)) {
    const duplicate = repo.notificationDeliveries.some(
      (d) => d.eventId === row.eventId && d.channel === row.channel,
    );
    if (duplicate) continue;
    const now = at;
    const delivery: NotificationDeliveryRow = {
      id: randomUUID(),
      ownerId: row.ownerId,
      monitorId: row.monitorId,
      incidentId: row.incidentId,
      eventId: row.eventId,
      eventType: row.eventType,
      channel: row.channel,
      payload: row.payload,
      destination: row.destination,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: NOTIFICATION_LIMITS.maxAttempts,
      nextAttemptAt: row.nextAttemptAt ?? now,
      leaseUntil: null,
      leaseToken: null,
      lastAttemptedAt: null,
      deliveredAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.notificationDeliveries.push(delivery);
    queued++;
  }
  return queued;
}
