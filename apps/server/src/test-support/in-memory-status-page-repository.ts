import { randomUUID } from 'node:crypto';
import {
  HEALTH_NEUTRAL_REASONS,
  type CheckFailureReason,
  type IncidentSeverity,
  type IncidentStatus,
  type MonitorStatus,
} from '@rain/shared';
import type { StatusPageMonitorRow, StatusPageRow } from '../db/schema.js';
import type {
  StatusPageQueries,
  StatusPageRepository,
} from '../status-pages/status-page-repository.js';
import type { InMemoryMonitorRepository } from './in-memory-monitor-repository.js';

/**
 * TEST ONLY. The status-page repository in memory, over an in-memory monitor repository's rows.
 * It mirrors the SQL rules: owner scoping, the unique slug (throws a 23505-coded error), the
 * same-owner trigger, cascades, ordering and the public query bounds. The SQL itself is covered by
 * tests/integration/status-pages.test.ts.
 */
export interface InMemoryStatusPageRepository extends StatusPageRepository {
  readonly pages: StatusPageRow[];
  readonly pageMonitors: StatusPageMonitorRow[];
}

const DAY = 86_400_000;

export function createInMemoryStatusPageRepository(
  repo: InMemoryMonitorRepository,
): InMemoryStatusPageRepository {
  let pages: StatusPageRow[] = [];
  let pageMonitors: StatusPageMonitorRow[] = [];
  const owned = (ownerId: string, id: string) =>
    pages.find((p) => p.id === id && p.ownerId === ownerId);

  const queries: StatusPageQueries = {
    async lockOwner() {},
    async countByOwner(ownerId) {
      return pages.filter((p) => p.ownerId === ownerId).length;
    },
    async listByOwner(ownerId) {
      return pages
        .filter((p) => p.ownerId === ownerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .map((p) => ({
          ...p,
          monitorCount: pageMonitors.filter((m) => m.statusPageId === p.id).length,
        }));
    },
    async findById(ownerId, id) {
      const p = owned(ownerId, id);
      return p && { ...p };
    },
    async slugExists(slug, exceptId) {
      return pages.some((p) => p.slug === slug && p.id !== exceptId);
    },
    async insert(values) {
      if (pages.some((p) => p.slug === values.slug)) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint_name: 'status_pages_slug_uq',
        });
      }
      const now = new Date();
      const row: StatusPageRow = {
        id: values.id ?? randomUUID(),
        ownerId: values.ownerId,
        title: values.title,
        description: values.description ?? null,
        slug: values.slug,
        published: values.published ?? false,
        publishedAt: values.publishedAt ?? null,
        createdAt: values.createdAt ?? now,
        updatedAt: values.updatedAt ?? now,
      };
      pages.push(row);
      return { ...row };
    },
    async update(ownerId, id, changes) {
      const p = owned(ownerId, id);
      if (!p) return undefined;
      if (changes.slug && pages.some((x) => x.slug === changes.slug && x.id !== id)) {
        throw Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint_name: 'status_pages_slug_uq',
        });
      }
      Object.assign(p, changes, { updatedAt: changes.updatedAt ?? new Date() });
      return { ...p };
    },
    async delete(ownerId, id) {
      if (!owned(ownerId, id)) return false;
      pages = pages.filter((p) => p.id !== id);
      pageMonitors = pageMonitors.filter((m) => m.statusPageId !== id);
      return true;
    },
    async listMonitors(pageId) {
      const page = pages.find((p) => p.id === pageId);
      if (!page) return [];
      return pageMonitors
        .filter((pm) => pm.statusPageId === pageId)
        .map((pm) => ({
          pm,
          m: repo.monitors.find((x) => x.id === pm.monitorId && x.ownerId === page.ownerId),
        }))
        .filter((x) => x.m)
        .sort(
          (a, b) =>
            a.pm.position - b.pm.position || a.pm.createdAt.getTime() - b.pm.createdAt.getTime(),
        )
        .map(({ pm, m }) => ({
          monitorId: pm.monitorId,
          monitorName: m!.name,
          displayName: pm.displayName,
          position: pm.position,
          currentStatus: m!.currentStatus as MonitorStatus,
          enabled: m!.enabled,
          lastCheckedAt: m!.lastCheckedAt,
        }));
    },
    async findOwnedMonitor(ownerId, monitorId) {
      const m = repo.monitors.find((x) => x.id === monitorId && x.ownerId === ownerId);
      return m && { id: m.id, name: m.name };
    },
    async insertMonitor(values) {
      const page = pages.find((p) => p.id === values.statusPageId);
      const monitor = repo.monitors.find((m) => m.id === values.monitorId);
      // The same-owner trigger and the primary key, emulated.
      if (!page || !monitor || monitor.ownerId !== page.ownerId) {
        throw Object.assign(new Error('monitor and status page must have the same owner'), {
          code: '23503',
        });
      }
      if (
        pageMonitors.some(
          (m) => m.statusPageId === values.statusPageId && m.monitorId === values.monitorId,
        )
      ) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      pageMonitors.push({ ...values, createdAt: new Date() });
    },
    async updateMonitor(pageId, monitorId, changes) {
      const row = pageMonitors.find((m) => m.statusPageId === pageId && m.monitorId === monitorId);
      if (!row) return false;
      Object.assign(row, changes);
      return true;
    },
    async deleteMonitor(pageId, monitorId) {
      const before = pageMonitors.length;
      pageMonitors = pageMonitors.filter(
        (m) => !(m.statusPageId === pageId && m.monitorId === monitorId),
      );
      return pageMonitors.length < before;
    },
    async findPublishedBySlug(slug) {
      const p = pages.find((x) => x.slug === slug && x.published);
      return p && { ...p };
    },
    async dayCounts(monitorIds, from) {
      const groups = new Map<
        string,
        { monitorId: string; dayMs: number; eligible: number; successful: number }
      >();
      for (const c of repo.checks) {
        if (!monitorIds.includes(c.monitorId) || c.checkedAt.getTime() < from.getTime()) continue;
        const eligible =
          c.failureReason === null ||
          !HEALTH_NEUTRAL_REASONS.has(c.failureReason as CheckFailureReason);
        if (!eligible) continue;
        const dayMs = Math.floor(c.checkedAt.getTime() / DAY) * DAY;
        const key = `${c.monitorId}:${dayMs}`;
        const g = groups.get(key) ?? { monitorId: c.monitorId, dayMs, eligible: 0, successful: 0 };
        g.eligible++;
        if (c.outcome !== 'FAILURE') g.successful++;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
    async publicIncidents(ownerId, monitorIds, from, limit) {
      return repo.incidents
        .filter(
          (i) =>
            i.ownerId === ownerId &&
            monitorIds.includes(i.monitorId) &&
            (i.startedAt.getTime() >= from.getTime() || i.status !== 'RESOLVED'),
        )
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, limit)
        .map((i) => ({
          monitorId: i.monitorId,
          status: i.status as IncidentStatus,
          severity: i.severity as IncidentSeverity,
          startedAt: i.startedAt,
          resolvedAt: i.resolvedAt,
        }));
    },
  };

  const self: InMemoryStatusPageRepository = {
    get pages() {
      return pages;
    },
    get pageMonitors() {
      return pageMonitors;
    },
    ...queries,
    async transaction(work) {
      const saved = {
        pages: pages.map((p) => ({ ...p })),
        pageMonitors: pageMonitors.map((m) => ({ ...m })),
      };
      try {
        return await work(queries);
      } catch (err) {
        pages = saved.pages;
        pageMonitors = saved.pageMonitors;
        throw err;
      }
    },
  };
  return self;
}
