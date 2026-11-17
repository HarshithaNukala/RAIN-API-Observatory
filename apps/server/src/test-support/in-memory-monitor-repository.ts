import { randomUUID } from 'node:crypto';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { MonitorHeaderRow, MonitorRow } from '../db/schema.js';
import type { PageCursor } from '../monitors/cursor.js';
import type {
  MonitorChanges,
  MonitorFilters,
  MonitorRepository,
  NewMonitorHeaderRow,
  NewMonitorRow,
} from '../monitors/monitor-repository.js';

/**
 * Unit-test stand-in for the Postgres repository. It applies the same owner scoping, ordering and
 * cursor rules, and restores its state when a transaction throws, so service logic can be tested
 * without a database. It does not prove the SQL itself: that is the integration suite's job.
 */
export interface InMemoryMonitorRepository extends MonitorRepository {
  readonly monitors: MonitorRow[];
  readonly headers: MonitorHeaderRow[];
  /** Config passed to each `transaction` call, in order. */
  readonly transactionConfigs: Array<PgTransactionConfig | undefined>;
}

const clone = <T extends object>(rows: T[]): T[] => rows.map((row) => ({ ...row }));

export function createInMemoryMonitorRepository(): InMemoryMonitorRepository {
  let monitors: MonitorRow[] = [];
  let headers: MonitorHeaderRow[] = [];
  const transactionConfigs: Array<PgTransactionConfig | undefined> = [];

  const owned = (ownerId: string, monitorId: string) =>
    monitors.find((m) => m.id === monitorId && m.ownerId === ownerId);

  const matches = (m: MonitorRow, ownerId: string, f: MonitorFilters) =>
    m.ownerId === ownerId &&
    (!f.search || m.name.toLowerCase().includes(f.search.toLowerCase())) &&
    (f.enabled === undefined || m.enabled === f.enabled) &&
    (!f.status || m.currentStatus === f.status);

  // created_at DESC, id DESC, like the real query.
  const newestFirst = (a: MonitorRow, b: MonitorRow) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  const isOlderThan = (m: MonitorRow, c: PageCursor) =>
    m.createdAt.getTime() < c.createdAt.getTime() ||
    (m.createdAt.getTime() === c.createdAt.getTime() && m.id < c.id);

  const repo: InMemoryMonitorRepository = {
    get monitors() {
      return monitors;
    },
    get headers() {
      return headers;
    },
    transactionConfigs,

    async lockOwner() {},

    async countByOwner(ownerId: string, filters: MonitorFilters = {}) {
      return monitors.filter((m) => matches(m, ownerId, filters)).length;
    },

    async insert(values: NewMonitorRow) {
      const now = new Date();
      const row: MonitorRow = {
        id: values.id ?? randomUUID(),
        ownerId: values.ownerId,
        name: values.name,
        description: values.description ?? null,
        url: values.url,
        method: values.method,
        expectedStatusCode: values.expectedStatusCode,
        timeoutMs: values.timeoutMs,
        latencyThresholdMs: values.latencyThresholdMs,
        checkIntervalSeconds: values.checkIntervalSeconds,
        requestBodyCiphertext: values.requestBodyCiphertext ?? null,
        requestBodyIv: values.requestBodyIv ?? null,
        requestBodyAuthTag: values.requestBodyAuthTag ?? null,
        requestBodyKeyVersion: values.requestBodyKeyVersion ?? null,
        bodyContentType: values.bodyContentType ?? null,
        enabled: values.enabled ?? true,
        currentStatus: values.currentStatus ?? 'UNKNOWN',
        consecutiveFailures: values.consecutiveFailures ?? 0,
        consecutiveSuccesses: values.consecutiveSuccesses ?? 0,
        lastCheckedAt: values.lastCheckedAt ?? null,
        nextCheckAt: values.nextCheckAt ?? now,
        leaseUntil: values.leaseUntil ?? null,
        createdAt: values.createdAt ?? now,
        updatedAt: values.updatedAt ?? now,
      };
      monitors.push(row);
      return { ...row };
    },

    async findById(ownerId: string, monitorId: string) {
      const row = owned(ownerId, monitorId);
      return row && { ...row };
    },

    async list(ownerId: string, filters: MonitorFilters, limit: number, after?: PageCursor) {
      return clone(
        monitors
          .filter((m) => matches(m, ownerId, filters) && (!after || isOlderThan(m, after)))
          .sort(newestFirst)
          .slice(0, limit),
      );
    },

    async update(ownerId: string, monitorId: string, changes: MonitorChanges) {
      const row = owned(ownerId, monitorId);
      if (!row) return undefined;
      Object.assign(row, changes, { updatedAt: changes.updatedAt ?? new Date() });
      return { ...row };
    },

    async delete(ownerId: string, monitorId: string) {
      if (!owned(ownerId, monitorId)) return false;
      monitors = monitors.filter((m) => m.id !== monitorId);
      headers = headers.filter((h) => h.monitorId !== monitorId);
      return true;
    },

    async listHeaders(ownerId: string, monitorId: string) {
      if (!owned(ownerId, monitorId)) return [];
      return clone(
        headers
          .filter((h) => h.monitorId === monitorId)
          .sort((a, b) => a.headerName.toLowerCase().localeCompare(b.headerName.toLowerCase())),
      );
    },

    async insertHeaders(rows: NewMonitorHeaderRow[]) {
      const now = new Date();
      for (const row of rows) {
        const clash = headers.some(
          (h) =>
            h.monitorId === row.monitorId &&
            h.headerName.toLowerCase() === row.headerName.toLowerCase(),
        );
        if (clash) throw new Error('unique violation: monitor_headers_monitor_name_uq');
        headers.push({
          id: row.id ?? randomUUID(),
          monitorId: row.monitorId,
          headerName: row.headerName,
          valueCiphertext: row.valueCiphertext,
          valueIv: row.valueIv,
          valueAuthTag: row.valueAuthTag,
          encryptionKeyVersion: row.encryptionKeyVersion,
          createdAt: row.createdAt ?? now,
          updatedAt: row.updatedAt ?? now,
        });
      }
    },

    async replaceHeader(ownerId, monitorId, headerId, values) {
      if (!owned(ownerId, monitorId)) return;
      const row = headers.find((h) => h.id === headerId && h.monitorId === monitorId);
      if (row) Object.assign(row, values, { updatedAt: new Date() });
    },

    async deleteHeaders(ownerId: string, monitorId: string, headerIds: string[]) {
      if (!owned(ownerId, monitorId)) return;
      headers = headers.filter((h) => !(h.monitorId === monitorId && headerIds.includes(h.id)));
    },

    async transaction(work, config) {
      transactionConfigs.push(config);
      const saved = { monitors: clone(monitors), headers: clone(headers) };
      try {
        return await work(repo);
      } catch (err) {
        monitors = saved.monitors;
        headers = saved.headers;
        throw err;
      }
    },
  };
  return repo;
}
