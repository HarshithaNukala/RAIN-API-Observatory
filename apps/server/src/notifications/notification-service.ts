import { randomBytes } from 'node:crypto';
import {
  NOTIFICATION_LIMITS,
  monitorOrigin,
  type NotificationAttemptOutcome,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationDeliveryDetail,
  type NotificationEventType,
  type NotificationList,
  type NotificationListQuery,
  type NotificationSettings,
  type NotificationSettingsUpdateResponse,
  type NotificationStatus,
  type UpdateNotificationSettings,
} from '@rain/shared';
import type { SecretBox } from '../crypto/secret-box.js';
import type {
  MonitorNotificationSettingsRow,
  NewMonitorNotificationSettingsRow,
} from '../db/schema.js';
import { AppError } from '../errors.js';
import { decodeCursor, encodeCursor } from '../monitors/cursor.js';
import { monitorNotFound } from '../monitors/monitor-service.js';
import { webhookHeaderContext, webhookSecretContext } from '../monitors/secret-contexts.js';
import type { DeliveryWithNames, NotificationRepository } from './notification-repository.js';

export interface NotificationService {
  getSettings(
    ownerId: string,
    ownerEmail: string | null,
    monitorId: string,
  ): Promise<NotificationSettings>;
  updateSettings(
    ownerId: string,
    ownerEmail: string | null,
    monitorId: string,
    patch: UpdateNotificationSettings,
  ): Promise<NotificationSettingsUpdateResponse>;
  list(ownerId: string, query: NotificationListQuery): Promise<NotificationList>;
  get(ownerId: string, id: string): Promise<NotificationDeliveryDetail>;
  retry(ownerId: string, id: string): Promise<NotificationDeliveryDetail>;
}

export interface NotificationServiceDependencies {
  repository: NotificationRepository;
  secretBox: SecretBox;
  /** Whether the worker has an email provider (from server config); shown, never the key. */
  emailConfigured: boolean;
  now?: () => Date;
}

export const notificationNotFound = () =>
  new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');

/** A new signing secret: 32 random bytes, shown to the owner once and stored only encrypted. */
export const generateSigningSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

const EMPTY_WEBHOOK = {
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
};
const NO_HEADER = {
  webhookHeaderName: null,
  webhookHeaderCiphertext: null,
  webhookHeaderIv: null,
  webhookHeaderAuthTag: null,
  webhookHeaderKeyVersion: null,
};

function toDelivery({
  delivery: d,
  monitorName,
  incidentTitle,
}: DeliveryWithNames): NotificationDelivery {
  return {
    id: d.id,
    eventType: d.eventType as NotificationEventType,
    channel: d.channel as NotificationChannel,
    status: d.status as NotificationStatus,
    destination: d.destination,
    monitor: { id: d.monitorId, name: monitorName },
    incident: { id: d.incidentId, title: incidentTitle },
    attempts: d.attempts,
    maxAttempts: d.maxAttempts,
    createdAt: d.createdAt.toISOString(),
    nextAttemptAt: d.status === 'PENDING' ? d.nextAttemptAt.toISOString() : null,
    lastAttemptedAt: d.lastAttemptedAt?.toISOString() ?? null,
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    lastError: d.lastError,
  };
}

export function createNotificationService(
  deps: NotificationServiceDependencies,
): NotificationService {
  const { repository, secretBox } = deps;
  const now = deps.now ?? (() => new Date());

  function toSettings(
    monitorId: string,
    ownerEmail: string | null,
    row: MonitorNotificationSettingsRow | undefined,
  ): NotificationSettings {
    return {
      monitorId,
      email: {
        enabled: row?.emailEnabled ?? false,
        address: ownerEmail,
        providerConfigured: deps.emailConfigured,
      },
      // Secrets and header values never leave the server: only the URL and the header name.
      webhook: row?.webhookUrl
        ? {
            enabled: row.webhookEnabled,
            url: row.webhookUrl,
            headerName: row.webhookHeaderName,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null,
    };
  }

  async function detail(
    tx:
      NotificationRepository | Parameters<Parameters<NotificationRepository['transaction']>[0]>[0],
    ownerId: string,
    found: DeliveryWithNames,
  ): Promise<NotificationDeliveryDetail> {
    const attempts = await tx.listAttempts(ownerId, found.delivery.id);
    return {
      ...toDelivery(found),
      attemptHistory: attempts.map((a) => ({
        attemptNumber: a.attemptNumber,
        startedAt: a.startedAt.toISOString(),
        finishedAt: a.finishedAt.toISOString(),
        outcome: a.outcome as NotificationAttemptOutcome,
        httpStatus: a.httpStatus,
        error: a.error,
      })),
    };
  }

  return {
    async getSettings(ownerId, ownerEmail, monitorId) {
      if (!(await repository.findMonitor(ownerId, monitorId))) throw monitorNotFound();
      return toSettings(monitorId, ownerEmail, await repository.getSettings(ownerId, monitorId));
    },

    async updateSettings(ownerId, ownerEmail, monitorId, patch) {
      return repository.transaction(async (tx) => {
        if (!(await tx.findMonitor(ownerId, monitorId))) throw monitorNotFound();
        const current = await tx.getSettings(ownerId, monitorId, { forUpdate: true });
        let signingSecret: string | null = null;
        const next: NewMonitorNotificationSettingsRow = {
          ...EMPTY_WEBHOOK,
          ...current,
          monitorId,
          ownerId,
          emailEnabled: patch.emailEnabled ?? current?.emailEnabled ?? false,
          updatedAt: now(),
        };

        if (patch.webhook === null) {
          Object.assign(next, EMPTY_WEBHOOK);
        } else if (patch.webhook) {
          const { url, enabled, header, rotateSecret } = patch.webhook;
          if (!current?.webhookSecretCiphertext || rotateSecret) {
            signingSecret = generateSigningSecret();
            const sealed = secretBox.encrypt(signingSecret, webhookSecretContext(monitorId));
            Object.assign(next, {
              webhookSecretCiphertext: sealed.ciphertext,
              webhookSecretIv: sealed.iv,
              webhookSecretAuthTag: sealed.authTag,
              webhookSecretKeyVersion: sealed.keyVersion,
            });
          }
          // A stored credential was entered for the old destination: never forward it to a new
          // origin. It must be entered again (the response shows headerName: null).
          const originChanged =
            current?.webhookUrl !== null &&
            current?.webhookUrl !== undefined &&
            monitorOrigin(current.webhookUrl) !== monitorOrigin(url);
          if (header === null || (header === undefined && originChanged)) {
            Object.assign(next, NO_HEADER);
          } else if (header) {
            const sealed = secretBox.encrypt(
              header.value,
              webhookHeaderContext(monitorId, header.name),
            );
            Object.assign(next, {
              webhookHeaderName: header.name,
              webhookHeaderCiphertext: sealed.ciphertext,
              webhookHeaderIv: sealed.iv,
              webhookHeaderAuthTag: sealed.authTag,
              webhookHeaderKeyVersion: sealed.keyVersion,
            });
          }
          next.webhookUrl = url;
          next.webhookEnabled = enabled;
        }

        const saved = await tx.saveSettings(next);
        return { settings: toSettings(monitorId, ownerEmail, saved), signingSecret };
      });
    },

    async list(ownerId, query) {
      const filters = { status: query.status, channel: query.channel, monitorId: query.monitorId };
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const { rows, total } = await repository.transaction(
        async (tx) => ({
          rows: await tx.listDeliveries(ownerId, filters, query.limit + 1, cursor),
          total: await tx.countDeliveries(ownerId, filters),
        }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toDelivery),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.delivery.createdAt, id: last.delivery.id })
            : null,
        total,
      };
    },

    async get(ownerId, id) {
      const found = await repository.findDelivery(ownerId, id);
      if (!found) throw notificationNotFound();
      return detail(repository, ownerId, found);
    },

    async retry(ownerId, id) {
      return repository.transaction(async (tx) => {
        const found = await tx.findDelivery(ownerId, id, { forUpdate: true });
        if (!found) throw notificationNotFound();
        if (found.delivery.status !== 'FAILED') {
          throw new AppError(
            409,
            'NOTIFICATION_NOT_RETRYABLE',
            found.delivery.status === 'SENT'
              ? 'This notification was already delivered.'
              : 'This notification is still being delivered.',
          );
        }
        // A fresh retry budget; attempt numbers continue, so history is kept.
        const updated = await tx.updateDelivery(ownerId, id, {
          status: 'PENDING',
          nextAttemptAt: now(),
          maxAttempts: found.delivery.attempts + NOTIFICATION_LIMITS.maxAttempts,
        });
        if (!updated) throw notificationNotFound();
        return detail(tx, ownerId, { ...found, delivery: updated });
      });
    },
  };
}
