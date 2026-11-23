import { randomUUID } from 'node:crypto';
import {
  HEADER_LIMITS,
  HEADERS_TOO_LARGE_MESSAGE,
  MANUAL_CHECK_COOLDOWN_MS,
  findMonitorConfigIssues,
  findMonitorUrlIssue,
  headerBytes,
  resolveBodyContentType,
  type CheckFailureReason,
  type CreateMonitor,
  type ManualCheckQueued,
  type MonitorCheck,
  type MonitorCheckList,
  type MonitorCheckListQuery,
  type MonitorCheckOutcome,
  type MonitorCheckSource,
  type Monitor,
  type MonitorHeaderSummary,
  type MonitorHeaderUpdate,
  type MonitorHeaderUpsert,
  type MonitorList,
  type MonitorListQuery,
  type MonitorMethod,
  type MonitorStatus,
  type MonitorSummary,
  type MonitorUpdateMeta,
  type UpdateMonitor,
  monitorOrigin,
} from '@rain/shared';
import type { SealedSecret, SecretBox } from '../crypto/secret-box.js';
import type { ProfileStore } from '../db/profiles.js';
import type { MonitorCheckRow, MonitorHeaderRow, MonitorRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  MonitorChanges,
  MonitorFilters,
  MonitorQueries,
  MonitorRepository,
  MonitorSummaryRow,
} from './monitor-repository.js';
import { bodyContext, headerContext } from './secret-contexts.js';

export interface MonitorUpdateResult {
  monitor: Monitor;
  meta: MonitorUpdateMeta;
}

export interface MonitorService {
  create(ownerId: string, input: CreateMonitor): Promise<Monitor>;
  list(ownerId: string, query: MonitorListQuery): Promise<MonitorList>;
  get(ownerId: string, monitorId: string): Promise<Monitor>;
  update(ownerId: string, monitorId: string, patch: UpdateMonitor): Promise<MonitorUpdateResult>;
  updateHeaders(ownerId: string, monitorId: string, update: MonitorHeaderUpdate): Promise<Monitor>;
  pause(ownerId: string, monitorId: string): Promise<Monitor>;
  resume(ownerId: string, monitorId: string): Promise<Monitor>;
  remove(ownerId: string, monitorId: string): Promise<void>;
  /** Queues a manual check for the worker. Never sends a request itself. */
  requestCheck(ownerId: string, monitorId: string): Promise<ManualCheckQueued>;
  listChecks(
    ownerId: string,
    monitorId: string,
    query: MonitorCheckListQuery,
  ): Promise<MonitorCheckList>;
}

export interface MonitorServiceDependencies {
  repository: MonitorRepository;
  profiles: ProfileStore;
  secretBox: SecretBox;
  maxMonitorsPerUser: number;
  now?: () => Date;
}

/**
 * The same response whether the monitor doesn't exist or belongs to someone else, so the API
 * never reveals which monitor IDs are in use.
 */
export const monitorNotFound = () => new AppError(404, 'MONITOR_NOT_FOUND', 'Monitor not found');

const validationError = (issues: Array<{ path: string; message: string }>) =>
  new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', issues);

// Deliberately generic: it says neither which secrets exist nor anything about their values.
export const originChangeConfirmationRequired = () =>
  new AppError(
    409,
    'MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED',
    'Changing the destination will remove the saved request headers and request body, because they were entered for the current destination. Send confirmOriginChange: true to proceed, then enter them again for the new destination.',
  );

/** The only shape a check leaves the service in: outcome and safe, sanitised details. */
function toCheck(row: MonitorCheckRow): MonitorCheck {
  return {
    id: row.id,
    checkedAt: row.checkedAt.toISOString(),
    source: row.source as MonitorCheckSource,
    outcome: row.outcome as MonitorCheckOutcome,
    statusCode: row.statusCode,
    latencyMs: row.latencyMs,
    failureReason: row.failureReason as CheckFailureReason | null,
    errorMessage: row.errorMessage,
  };
}

function toSummary(row: MonitorSummaryRow): MonitorSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    method: row.method as MonitorMethod,
    expectedStatusCode: row.expectedStatusCode,
    timeoutMs: row.timeoutMs,
    latencyThresholdMs: row.latencyThresholdMs,
    checkIntervalSeconds: row.checkIntervalSeconds,
    allowMutatingRequests: row.allowMutatingRequests,
    enabled: row.enabled,
    currentStatus: row.currentStatus as MonitorStatus,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    // A paused monitor has no upcoming check; the stored value is only the scheduler's bookkeeping.
    nextCheckAt: row.enabled ? row.nextCheckAt.toISOString() : null,
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
    manualCheckQueuedAt: row.manualCheckRequestedAt?.toISOString() ?? null,
    lastManualCheckAt: row.lastManualCheckAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Size of a stored header without decrypting it. AES-GCM ciphertext is exactly as long as the
 * plaintext, so the decoded ciphertext length is the value's UTF-8 size.
 */
const storedHeaderBytes = (row: MonitorHeaderRow) =>
  headerBytes(row.headerName, '') + Buffer.from(row.valueCiphertext, 'base64').length;

/** The only shape a stored header ever leaves the service in: name and presence, no value. */
function toHeaderSummary(row: MonitorHeaderRow): MonitorHeaderSummary {
  return { name: row.headerName, configured: true, updatedAt: row.updatedAt.toISOString() };
}

export function createMonitorService(deps: MonitorServiceDependencies): MonitorService {
  const { repository, secretBox } = deps;
  const now = deps.now ?? (() => new Date());

  function sealBody(monitorId: string, body: string | null) {
    const sealed = body ? secretBox.encrypt(body, bodyContext(monitorId)) : null;
    return {
      requestBodyCiphertext: sealed?.ciphertext ?? null,
      requestBodyIv: sealed?.iv ?? null,
      requestBodyAuthTag: sealed?.authTag ?? null,
      requestBodyKeyVersion: sealed?.keyVersion ?? null,
    };
  }

  function openBody(row: MonitorRow): string | null {
    if (
      row.requestBodyCiphertext === null ||
      row.requestBodyIv === null ||
      row.requestBodyAuthTag === null ||
      row.requestBodyKeyVersion === null
    ) {
      return null;
    }
    const sealed: SealedSecret = {
      ciphertext: row.requestBodyCiphertext,
      iv: row.requestBodyIv,
      authTag: row.requestBodyAuthTag,
      keyVersion: row.requestBodyKeyVersion,
    };
    return secretBox.decrypt(sealed, bodyContext(row.id));
  }

  function sealHeader(monitorId: string, header: MonitorHeaderUpsert) {
    const sealed = secretBox.encrypt(header.value, headerContext(monitorId, header.name));
    return {
      headerName: header.name,
      valueCiphertext: sealed.ciphertext,
      valueIv: sealed.iv,
      valueAuthTag: sealed.authTag,
      encryptionKeyVersion: sealed.keyVersion,
    };
  }

  function toMonitor(row: MonitorRow, headers: MonitorHeaderRow[], body = openBody(row)): Monitor {
    return {
      ...toSummary(row),
      requestBody: body,
      bodyContentType: row.bodyContentType,
      headers: headers.map(toHeaderSummary),
    };
  }

  async function load(tx: MonitorQueries, ownerId: string, monitorId: string): Promise<Monitor> {
    const row = await tx.findById(ownerId, monitorId);
    if (!row) throw monitorNotFound();
    return toMonitor(row, await tx.listHeaders(ownerId, monitorId));
  }

  async function setEnabled(
    ownerId: string,
    monitorId: string,
    enabled: boolean,
  ): Promise<Monitor> {
    return repository.transaction(async (tx) => {
      // Health status and counters are left alone: pausing or resuming is not a check result.
      // The worker lease is NOT touched: a check in flight keeps its lease until it completes, so
      // a quick pause/resume can't let a second worker claim the monitor while it is running. The
      // completing worker sees the pause and records the check without changing health.
      const changes: MonitorChanges = enabled
        ? { enabled: true, nextCheckAt: now() }
        : { enabled: false, manualCheckRequestedAt: null };
      const row = await tx.update(ownerId, monitorId, changes);
      if (!row) throw monitorNotFound();
      return toMonitor(row, await tx.listHeaders(ownerId, monitorId));
    });
  }

  return {
    async create(ownerId, input) {
      // monitors.owner_id references profiles, which is created lazily on first API access.
      await deps.profiles.ensure(ownerId);
      const id = randomUUID();

      return repository.transaction(async (tx) => {
        await tx.lockOwner(ownerId);
        if ((await tx.countByOwner(ownerId)) >= deps.maxMonitorsPerUser) {
          throw new AppError(
            409,
            'MONITOR_LIMIT_REACHED',
            `You've reached the limit of ${deps.maxMonitorsPerUser} monitors. Delete one to add another.`,
          );
        }
        const row = await tx.insert({
          id,
          ownerId,
          name: input.name,
          description: input.description,
          url: input.url,
          method: input.method,
          expectedStatusCode: input.expectedStatusCode,
          timeoutMs: input.timeoutMs,
          latencyThresholdMs: input.latencyThresholdMs,
          checkIntervalSeconds: input.checkIntervalSeconds,
          allowMutatingRequests: input.allowMutatingRequests,
          ...sealBody(id, input.requestBody),
          bodyContentType: resolveBodyContentType(input.requestBody, input.bodyContentType),
          // Due immediately once a monitoring engine exists; no check result is invented here.
          nextCheckAt: now(),
        });
        await tx.insertHeaders(input.headers.map((h) => ({ monitorId: id, ...sealHeader(id, h) })));
        return toMonitor(row, await tx.listHeaders(ownerId, id), input.requestBody);
      });
    },

    async list(ownerId, query) {
      const filters: MonitorFilters = {
        search: query.search || undefined,
        enabled: query.state === 'all' ? undefined : query.state === 'enabled',
        status: query.status,
      };
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      // One read-only snapshot, so the page, the filtered total and the quota always agree.
      const { rows, total, used } = await repository.transaction(
        async (tx) => ({
          rows: await tx.list(ownerId, filters, query.limit + 1, after),
          total: await tx.countByOwner(ownerId, filters),
          used: await tx.countByOwner(ownerId),
        }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toSummary),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.createdAt, id: last.id })
            : null,
        total,
        quota: { used, limit: deps.maxMonitorsPerUser },
      };
    },

    get: (ownerId, monitorId) => load(repository, ownerId, monitorId),

    async update(ownerId, monitorId, patch) {
      return repository.transaction(async (tx) => {
        const current = await tx.findById(ownerId, monitorId, { forUpdate: true });
        if (!current) throw monitorNotFound();

        // Saved headers and body were entered for the current destination. Moving the monitor to
        // another origin must not silently send them somewhere else.
        const originChanged =
          patch.url !== undefined && monitorOrigin(patch.url) !== monitorOrigin(current.url);
        const storedHeaders = originChanged ? await tx.listHeaders(ownerId, monitorId) : [];
        const hasSavedSecrets = storedHeaders.length > 0 || current.requestBodyCiphertext !== null;
        const clearSaved = originChanged && hasSavedSecrets;
        if (clearSaved && patch.confirmOriginChange !== true) {
          throw originChangeConfirmationRequired();
        }
        if (clearSaved) {
          await tx.deleteHeaders(
            ownerId,
            monitorId,
            storedHeaders.map((h) => h.id),
          );
        }

        const bodyChanged = 'requestBody' in patch;
        const requestBody = bodyChanged
          ? (patch.requestBody ?? null)
          : clearSaved
            ? null
            : openBody(current);
        // A kept body sealed with a retired key is re-encrypted with the current one, so stored
        // data migrates off old keys as monitors are edited.
        const rewrapBody =
          !bodyChanged &&
          !clearSaved &&
          requestBody !== null &&
          current.requestBodyKeyVersion !== secretBox.currentKeyVersion;
        // An explicitly supplied content type is validated as given; otherwise the stored one
        // is kept while the stored body is kept, and dropped with it.
        const declaredContentType =
          'bodyContentType' in patch
            ? (patch.bodyContentType ?? null)
            : requestBody && !clearSaved
              ? current.bodyContentType
              : null;
        const issues = findMonitorConfigIssues({
          method: patch.method ?? (current.method as MonitorMethod),
          timeoutMs: patch.timeoutMs ?? current.timeoutMs,
          latencyThresholdMs: patch.latencyThresholdMs ?? current.latencyThresholdMs,
          requestBody,
          bodyContentType: declaredContentType,
          allowMutatingRequests: patch.allowMutatingRequests ?? current.allowMutatingRequests,
        });
        if (issues.length > 0) throw validationError(issues);

        const changes: MonitorChanges = {
          ...(patch.name !== undefined && { name: patch.name }),
          ...('description' in patch && { description: patch.description ?? null }),
          ...(patch.url !== undefined && { url: patch.url }),
          ...(patch.method !== undefined && { method: patch.method }),
          ...(patch.expectedStatusCode !== undefined && {
            expectedStatusCode: patch.expectedStatusCode,
          }),
          ...(patch.timeoutMs !== undefined && { timeoutMs: patch.timeoutMs }),
          ...(patch.latencyThresholdMs !== undefined && {
            latencyThresholdMs: patch.latencyThresholdMs,
          }),
          ...(patch.checkIntervalSeconds !== undefined && {
            checkIntervalSeconds: patch.checkIntervalSeconds,
          }),
          ...(patch.allowMutatingRequests !== undefined && {
            allowMutatingRequests: patch.allowMutatingRequests,
          }),
          ...((bodyChanged || rewrapBody || clearSaved) && sealBody(monitorId, requestBody)),
          bodyContentType: resolveBodyContentType(requestBody, declaredContentType),
        };
        const row = await tx.update(ownerId, monitorId, changes);
        if (!row) throw monitorNotFound();
        // Apart from an origin change, headers are never written here: they are read back.
        return {
          monitor: toMonitor(row, await tx.listHeaders(ownerId, monitorId), requestBody),
          meta: { originChanged, savedConfigurationCleared: clearSaved },
        };
      });
    },

    async updateHeaders(ownerId, monitorId, update) {
      return repository.transaction(async (tx) => {
        // Locking the monitor row serialises concurrent header edits for this monitor.
        const monitor = await tx.findById(ownerId, monitorId, { forUpdate: true });
        if (!monitor) throw monitorNotFound();

        const existing = new Map(
          (await tx.listHeaders(ownerId, monitorId)).map((h) => [h.headerName.toLowerCase(), h]),
        );
        const removing = update.remove
          .map((name) => existing.get(name.toLowerCase()))
          .filter((h) => h !== undefined);
        const creating = update.upsert.filter((h) => !existing.has(h.name.toLowerCase()));

        const resultingCount = existing.size - removing.length + creating.length;
        if (resultingCount > HEADER_LIMITS.maxCount) {
          throw validationError([
            {
              path: 'upsert',
              message: `A monitor can have at most ${HEADER_LIMITS.maxCount} headers`,
            },
          ]);
        }

        // The size limit applies to the monitor's resulting header set, not just this request:
        // headers kept as they are count with their stored size.
        const touched = new Set([
          ...update.remove.map((name) => name.toLowerCase()),
          ...update.upsert.map((h) => h.name.toLowerCase()),
        ]);
        const resultingBytes =
          [...existing.entries()]
            .filter(([key]) => !touched.has(key))
            .reduce((sum, [, row]) => sum + storedHeaderBytes(row), 0) +
          update.upsert.reduce((sum, h) => sum + headerBytes(h.name, h.value), 0);
        if (resultingBytes > HEADER_LIMITS.maxAggregateBytes) {
          throw validationError([{ path: 'upsert', message: HEADERS_TOO_LARGE_MESSAGE }]);
        }

        await tx.deleteHeaders(
          ownerId,
          monitorId,
          removing.map((h) => h.id),
        );
        for (const header of update.upsert) {
          const stored = existing.get(header.name.toLowerCase());
          if (stored) {
            await tx.replaceHeader(ownerId, monitorId, stored.id, sealHeader(monitorId, header));
          }
        }
        await tx.insertHeaders(creating.map((h) => ({ monitorId, ...sealHeader(monitorId, h) })));

        const row = await tx.update(ownerId, monitorId, { updatedAt: now() });
        if (!row) throw monitorNotFound();
        return toMonitor(row, await tx.listHeaders(ownerId, monitorId));
      });
    },

    pause: (ownerId, monitorId) => setEnabled(ownerId, monitorId, false),

    resume: (ownerId, monitorId) => setEnabled(ownerId, monitorId, true),

    async requestCheck(ownerId, monitorId) {
      return repository.transaction(async (tx) => {
        // The row lock serialises concurrent Check Now clicks for this monitor.
        const row = await tx.findById(ownerId, monitorId, { forUpdate: true });
        if (!row) throw monitorNotFound();
        if (!row.enabled) {
          throw new AppError(
            409,
            'MONITOR_PAUSED',
            'This monitor is paused. Resume it to run checks.',
          );
        }
        if (row.manualCheckRequestedAt) {
          throw new AppError(
            409,
            'CHECK_ALREADY_QUEUED',
            'A manual check for this monitor is already queued.',
            {
              queuedAt: row.manualCheckRequestedAt.toISOString(),
            },
          );
        }
        const at = now();
        if (row.lastManualCheckAt) {
          const waitMs = row.lastManualCheckAt.getTime() + MANUAL_CHECK_COOLDOWN_MS - at.getTime();
          if (waitMs > 0) {
            throw new AppError(
              429,
              'CHECK_COOLDOWN',
              `This monitor was checked manually moments ago. Try again in ${Math.ceil(waitMs / 1000)} s.`,
              { retryAfterSeconds: Math.ceil(waitMs / 1000) },
            );
          }
        }
        // The same rules the executor applies, so a request that can only be refused isn't queued.
        const issues = [
          ...findMonitorConfigIssues({
            method: row.method as MonitorMethod,
            timeoutMs: row.timeoutMs,
            latencyThresholdMs: row.latencyThresholdMs,
            requestBody: row.requestBodyCiphertext === null ? null : '(stored)',
            bodyContentType: row.bodyContentType,
            allowMutatingRequests: row.allowMutatingRequests,
          }),
          ...(() => {
            const issue = findMonitorUrlIssue(row.url);
            return issue ? [{ path: 'url', message: issue.message }] : [];
          })(),
        ];
        if (issues.length > 0) {
          throw new AppError(
            422,
            'MONITOR_CONFIGURATION_INVALID',
            "This monitor can't be checked until its configuration is fixed.",
            issues,
          );
        }
        await tx.update(ownerId, monitorId, {
          manualCheckRequestedAt: at,
          updatedAt: row.updatedAt,
        });
        return { monitorId, status: 'QUEUED', queuedAt: at.toISOString() };
      });
    },

    async listChecks(ownerId, monitorId, query) {
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      const { exists, rows } = await repository.transaction(
        async (tx) => ({
          exists: (await tx.findById(ownerId, monitorId)) !== undefined,
          rows: await tx.listChecks(ownerId, monitorId, {
            source: query.source,
            limit: query.limit + 1,
            after: after && { checkedAt: after.createdAt, id: after.id },
          }),
        }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      if (!exists) throw monitorNotFound();
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toCheck),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.checkedAt, id: last.id })
            : null,
      };
    },

    async remove(ownerId, monitorId) {
      // monitor_headers rows go with it through ON DELETE CASCADE, in the same statement.
      if (!(await repository.delete(ownerId, monitorId))) throw monitorNotFound();
    },
  };
}
