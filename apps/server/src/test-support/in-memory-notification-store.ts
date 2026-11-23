import { randomUUID } from 'node:crypto';
import type { MonitorNotificationSettingsRow, NotificationDeliveryRow } from '../db/schema.js';
import type { ClaimedDelivery, DispatchStore } from '../notifications/dispatch-store.js';
import type { NotificationRepository } from '../notifications/notification-repository.js';
import type { InMemoryMonitorRepository } from './in-memory-monitor-repository.js';

/**
 * TEST ONLY. In-memory twins of the notification repository (API) and the dispatch store
 * (worker), over an in-memory monitor repository's rows. They mirror the SQL semantics: owner
 * scoping, (event, channel) uniqueness, leases with tokens, attempts counted at claim time,
 * expired-lease recovery. The SQL itself is covered by tests/integration/notifications.test.ts.
 */

export function createInMemoryNotificationRepository(
  repo: InMemoryMonitorRepository,
): NotificationRepository {
  const monitorOf = (ownerId: string, id: string) =>
    repo.monitors.find((m) => m.id === id && m.ownerId === ownerId);
  const named = (d: NotificationDeliveryRow) => ({
    delivery: { ...d },
    monitorName: repo.monitors.find((m) => m.id === d.monitorId)?.name ?? '',
    incidentTitle: repo.incidents.find((i) => i.id === d.incidentId)?.title ?? '',
  });
  const matches = (
    d: NotificationDeliveryRow,
    ownerId: string,
    f: {
      status?: string | undefined;
      channel?: string | undefined;
      monitorId?: string | undefined;
    },
  ) =>
    d.ownerId === ownerId &&
    (!f.status || d.status === f.status) &&
    (!f.channel || d.channel === f.channel) &&
    (!f.monitorId || d.monitorId === f.monitorId);

  const self: NotificationRepository = {
    async findMonitor(ownerId, monitorId) {
      const m = monitorOf(ownerId, monitorId);
      return m && { id: m.id, name: m.name };
    },
    async getSettings(ownerId, monitorId) {
      const s = repo.notificationSettings.find(
        (x) => x.monitorId === monitorId && x.ownerId === ownerId,
      );
      return s && { ...s };
    },
    async saveSettings(values) {
      const now = new Date();
      const existing = repo.notificationSettings.find((x) => x.monitorId === values.monitorId);
      const row: MonitorNotificationSettingsRow = {
        emailEnabled: false,
        webhookEnabled: false,
        webhookUrl: null,
        webhookSecretCiphertext: null,
        webhookSecretIv: null,
        webhookSecretAuthTag: null,
        webhookSecretKeyVersion: null,
        webhookHeaderName: null,
        webhookHeaderCiphertext: null,
        webhookHeaderIv: null,
        webhookHeaderAuthTag: null,
        webhookHeaderKeyVersion: null,
        createdAt: existing?.createdAt ?? now,
        ...existing,
        ...(values as Partial<MonitorNotificationSettingsRow>),
        monitorId: values.monitorId,
        ownerId: values.ownerId,
        updatedAt: now,
      };
      // The SQL CHECK constraints, emulated: a configured webhook is complete; enabled needs a URL.
      const secretParts = [
        row.webhookUrl,
        row.webhookSecretCiphertext,
        row.webhookSecretIv,
        row.webhookSecretAuthTag,
        row.webhookSecretKeyVersion,
      ];
      const set = secretParts.filter((v) => v !== null && v !== undefined).length;
      if ((set !== 0 && set !== 5) || (row.webhookEnabled && !row.webhookUrl)) {
        throw new Error('check violation: monitor_notification_settings_webhook_*');
      }
      repo.notificationSettings = [
        ...repo.notificationSettings.filter((x) => x.monitorId !== values.monitorId),
        row,
      ];
      return { ...row };
    },
    async listDeliveries(ownerId, filters, limit, after) {
      return repo.notificationDeliveries
        .filter(
          (d) =>
            matches(d, ownerId, filters) &&
            (!after ||
              d.createdAt.getTime() < after.createdAt.getTime() ||
              (d.createdAt.getTime() === after.createdAt.getTime() && d.id < after.id)),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(named);
    },
    async countDeliveries(ownerId, filters) {
      return repo.notificationDeliveries.filter((d) => matches(d, ownerId, filters)).length;
    },
    async findDelivery(ownerId, id) {
      const d = repo.notificationDeliveries.find((x) => x.id === id && x.ownerId === ownerId);
      return d && named(d);
    },
    async listAttempts(ownerId, deliveryId) {
      const d = repo.notificationDeliveries.find(
        (x) => x.id === deliveryId && x.ownerId === ownerId,
      );
      if (!d) return [];
      return repo.notificationAttempts
        .filter((a) => a.deliveryId === deliveryId)
        .sort((a, b) => a.attemptNumber - b.attemptNumber)
        .map((a) => ({ ...a }));
    },
    async updateDelivery(ownerId, id, changes) {
      const d = repo.notificationDeliveries.find((x) => x.id === id && x.ownerId === ownerId);
      if (!d) return undefined;
      Object.assign(d, changes, { updatedAt: new Date() });
      return { ...d };
    },
    transaction: (work) => repo.transaction(() => work(self)),
  };
  return self;
}

export interface InMemoryDispatchStore extends DispatchStore {
  failNext(kind: 'claim' | 'complete'): void;
}

export function createInMemoryDispatchStore(
  repo: InMemoryMonitorRepository,
  options: { now?: () => Date } = {},
): InMemoryDispatchStore {
  const now = options.now ?? (() => new Date());
  const failures = new Set<string>();
  const maybeFail = (kind: string) => {
    if (failures.delete(kind)) throw new Error('connection terminated unexpectedly');
  };

  return {
    failNext(kind) {
      failures.add(kind);
    },
    async claim(limit, leaseSeconds) {
      maybeFail('claim');
      const t = now().getTime();
      for (const d of repo.notificationDeliveries) {
        if (
          d.status === 'PROCESSING' &&
          d.leaseUntil!.getTime() < t &&
          d.attempts >= d.maxAttempts
        ) {
          Object.assign(d, {
            status: 'FAILED',
            leaseUntil: null,
            leaseToken: null,
            lastError: 'The delivery attempt did not complete (the worker stopped during it)',
          });
        }
      }
      const due = repo.notificationDeliveries
        .filter(
          (d) =>
            (d.status === 'PENDING' && d.nextAttemptAt.getTime() <= t) ||
            (d.status === 'PROCESSING' &&
              d.leaseUntil!.getTime() < t &&
              d.attempts < d.maxAttempts),
        )
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
      return due.map((d): ClaimedDelivery => {
        Object.assign(d, {
          status: 'PROCESSING',
          leaseToken: randomUUID(),
          leaseUntil: new Date(t + leaseSeconds * 1000),
          attempts: d.attempts + 1,
          lastAttemptedAt: new Date(t),
        });
        return { delivery: { ...d }, leaseToken: d.leaseToken! };
      });
    },
    async loadContext(delivery) {
      if (delivery.channel === 'EMAIL') {
        return { ownerEmail: repo.ownerEmails.get(delivery.ownerId) ?? null, settings: null };
      }
      const s = repo.notificationSettings.find(
        (x) => x.monitorId === delivery.monitorId && x.ownerId === delivery.ownerId,
      );
      return { ownerEmail: null, settings: s ? { ...s } : null };
    },
    async complete(claim, attempt) {
      maybeFail('complete');
      const d = repo.notificationDeliveries.find((x) => x.id === claim.delivery.id);
      if (!d || d.leaseToken !== claim.leaseToken) return false;
      const { result, decision } = attempt;
      if (
        !repo.notificationAttempts.some(
          (a) => a.deliveryId === d.id && a.attemptNumber === claim.delivery.attempts,
        )
      ) {
        repo.notificationAttempts.push({
          id: randomUUID(),
          deliveryId: d.id,
          attemptNumber: claim.delivery.attempts,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          outcome: result.outcome,
          httpStatus: result.httpStatus,
          error: result.outcome === 'SUCCESS' ? null : result.error,
        });
      }
      Object.assign(d, {
        status: decision.status,
        nextAttemptAt: decision.nextAttemptAt,
        lastError: decision.lastError,
        deliveredAt: decision.status === 'SENT' ? decision.deliveredAt : null,
        leaseUntil: null,
        leaseToken: null,
      });
      return true;
    },
  };
}
