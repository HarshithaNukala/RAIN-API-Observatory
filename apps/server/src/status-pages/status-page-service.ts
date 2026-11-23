import {
  STATUS_PAGE_LIMITS,
  type AddStatusPageMonitor,
  type CreateStatusPage,
  type PublicStatusPage,
  type StatusPage,
  type StatusPageList,
  type StatusPageSummary,
  type UpdateStatusPage,
} from '@rain/shared';
import type { ProfileStore } from '../db/profiles.js';
import type { StatusPageRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import { monitorNotFound } from '../monitors/monitor-service.js';
import {
  availabilityDays,
  historyStart,
  overallStatus,
  publicIncident,
  publicServiceStatus,
  slugFromTitle,
  slugWithSuffix,
} from './public-status.js';
import type {
  PageMonitorRow,
  StatusPageQueries,
  StatusPageRepository,
} from './status-page-repository.js';

export interface StatusPageService {
  create(ownerId: string, input: CreateStatusPage): Promise<StatusPage>;
  list(ownerId: string): Promise<StatusPageList>;
  get(ownerId: string, id: string): Promise<StatusPage>;
  update(ownerId: string, id: string, patch: UpdateStatusPage): Promise<StatusPage>;
  setPublished(ownerId: string, id: string, published: boolean): Promise<StatusPage>;
  remove(ownerId: string, id: string): Promise<void>;
  addMonitor(ownerId: string, id: string, input: AddStatusPageMonitor): Promise<StatusPage>;
  removeMonitor(ownerId: string, id: string, monitorId: string): Promise<StatusPage>;
  renameMonitor(
    ownerId: string,
    id: string,
    monitorId: string,
    displayName: string,
  ): Promise<StatusPage>;
  reorderMonitors(ownerId: string, id: string, monitorIds: string[]): Promise<StatusPage>;
  /** The public view of an owned page, published or not (for previews). */
  preview(ownerId: string, id: string): Promise<PublicStatusPage>;
  /** The public view of a published page; 404 for unknown or unpublished slugs. */
  publicView(slug: string): Promise<PublicStatusPage>;
}

export interface StatusPageServiceDependencies {
  repository: StatusPageRepository;
  profiles: ProfileStore;
  now?: () => Date;
}

/** Same answer for missing, foreign and (publicly) unpublished pages. */
export const statusPageNotFound = () =>
  new AppError(404, 'STATUS_PAGE_NOT_FOUND', 'Status page not found');

const slugTaken = () =>
  new AppError(
    409,
    'STATUS_PAGE_SLUG_TAKEN',
    'This address is already in use. Choose another one.',
    [{ path: 'slug', message: 'This address is already in use' }],
  );

/** A unique-index violation on the slug (a concurrent claim of the same address). */
function isSlugConflict(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const {
      code,
      constraint_name: constraint,
      cause,
    } = current as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (code === '23505' && (constraint === undefined || constraint === 'status_pages_slug_uq'))
      return true;
    current = cause;
  }
  return false;
}

function toPage(row: StatusPageRow, monitors: PageMonitorRow[]): StatusPage {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    slug: row.slug,
    published: row.published,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    monitors: monitors.map((m) => ({
      monitorId: m.monitorId,
      monitorName: m.monitorName,
      displayName: m.displayName,
      position: m.position,
      currentStatus: m.currentStatus,
      enabled: m.enabled,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createStatusPageService(deps: StatusPageServiceDependencies): StatusPageService {
  const { repository } = deps;
  const now = deps.now ?? (() => new Date());

  async function loadOwned(tx: StatusPageQueries, ownerId: string, id: string, forUpdate = false) {
    const row = await tx.findById(ownerId, id, { forUpdate });
    if (!row) throw statusPageNotFound();
    return row;
  }

  /** Runs a change to an owned page and its monitors, then returns the fresh configuration. */
  function mutate(
    ownerId: string,
    id: string,
    work: (tx: StatusPageQueries, page: StatusPageRow) => Promise<void>,
  ) {
    return repository.transaction(async (tx) => {
      const page = await loadOwned(tx, ownerId, id, true);
      await work(tx, page);
      // Any change to the page or its monitors counts as an update of the page.
      const updated = (await tx.update(ownerId, id, { updatedAt: now() })) ?? page;
      return toPage(updated, await tx.listMonitors(id));
    });
  }

  /** Rewrites positions as 0..n-1 in the given order. */
  async function writeOrder(tx: StatusPageQueries, pageId: string, monitorIds: string[]) {
    for (const [position, monitorId] of monitorIds.entries()) {
      await tx.updateMonitor(pageId, monitorId, { position });
    }
  }

  async function buildPublicView(
    tx: StatusPageQueries,
    page: StatusPageRow,
  ): Promise<PublicStatusPage> {
    const at = now();
    const from = historyStart(at);
    const monitors = await tx.listMonitors(page.id);
    const ids = monitors.map((m) => m.monitorId);
    const [counts, incidentRows] = await Promise.all([
      tx.dayCounts(ids, from),
      tx.publicIncidents(page.ownerId, ids, from, STATUS_PAGE_LIMITS.publicIncidents),
    ]);
    const services = monitors.map((m, index) => {
      const history = availabilityDays(
        counts.filter((c) => c.monitorId === m.monitorId),
        at,
      );
      return {
        key: `s${index + 1}`,
        name: m.displayName,
        status: publicServiceStatus(m.currentStatus, m.enabled),
        lastCheckedAt: m.lastCheckedAt?.toISOString() ?? null,
        availabilityPercent: history.availabilityPercent,
        days: history.days,
      };
    });
    const nameOf = new Map(monitors.map((m) => [m.monitorId, m.displayName]));
    return {
      title: page.title,
      description: page.description,
      overallStatus: overallStatus(services),
      services,
      incidents: incidentRows.map((i, index) =>
        publicIncident(i, nameOf.get(i.monitorId) ?? 'A service', `i${index + 1}`),
      ),
      historyDays: STATUS_PAGE_LIMITS.historyDays,
      generatedAt: at.toISOString(),
    };
  }

  return {
    async create(ownerId, input) {
      await deps.profiles.ensure(ownerId);
      return repository.transaction(async (tx) => {
        await tx.lockOwner(ownerId);
        if ((await tx.countByOwner(ownerId)) >= STATUS_PAGE_LIMITS.pagesPerOwner) {
          throw new AppError(
            409,
            'STATUS_PAGE_LIMIT_REACHED',
            `You can have up to ${STATUS_PAGE_LIMITS.pagesPerOwner} status pages. Delete one to add another.`,
          );
        }
        let slug = input.slug;
        if (slug) {
          if (await tx.slugExists(slug)) throw slugTaken();
        } else {
          slug = slugFromTitle(input.title);
          if (await tx.slugExists(slug)) slug = slugWithSuffix(slug);
        }
        try {
          const row = await tx.insert({
            ownerId,
            title: input.title,
            description: input.description ?? null,
            slug,
            published: false,
          });
          return toPage(row, []);
        } catch (err) {
          if (isSlugConflict(err)) throw slugTaken();
          throw err;
        }
      });
    },

    async list(ownerId) {
      const rows = await repository.listByOwner(ownerId);
      const items: StatusPageSummary[] = rows.map((r) => {
        const { monitors: _m, ...page } = toPage(r, []);
        return { ...page, monitorCount: r.monitorCount };
      });
      return { items, quota: { used: rows.length, limit: STATUS_PAGE_LIMITS.pagesPerOwner } };
    },

    async get(ownerId, id) {
      const page = await loadOwned(repository, ownerId, id);
      return toPage(page, await repository.listMonitors(id));
    },

    async update(ownerId, id, patch) {
      try {
        return await mutate(ownerId, id, async (tx, page) => {
          if (patch.slug && patch.slug !== page.slug && (await tx.slugExists(patch.slug, id)))
            throw slugTaken();
          await tx.update(ownerId, id, {
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.slug !== undefined && { slug: patch.slug }),
          });
        });
      } catch (err) {
        if (isSlugConflict(err)) throw slugTaken();
        throw err;
      }
    },

    setPublished(ownerId, id, published) {
      return mutate(ownerId, id, async (tx, page) => {
        if (page.published === published) return;
        await tx.update(ownerId, id, { published, ...(published && { publishedAt: now() }) });
      });
    },

    async remove(ownerId, id) {
      // Its monitor selections go with it (ON DELETE CASCADE).
      if (!(await repository.delete(ownerId, id))) throw statusPageNotFound();
    },

    addMonitor(ownerId, id, input) {
      return mutate(ownerId, id, async (tx) => {
        const monitor = await tx.findOwnedMonitor(ownerId, input.monitorId);
        if (!monitor) throw monitorNotFound();
        const current = await tx.listMonitors(id);
        if (current.some((m) => m.monitorId === monitor.id)) {
          throw new AppError(
            409,
            'STATUS_PAGE_MONITOR_EXISTS',
            'This monitor is already on the page.',
          );
        }
        if (current.length >= STATUS_PAGE_LIMITS.monitorsPerPage) {
          throw new AppError(
            409,
            'STATUS_PAGE_MONITOR_LIMIT_REACHED',
            `A status page can show up to ${STATUS_PAGE_LIMITS.monitorsPerPage} monitors.`,
          );
        }
        await tx.insertMonitor({
          statusPageId: id,
          monitorId: monitor.id,
          displayName: input.displayName ?? monitor.name,
          position: current.length,
        });
      });
    },

    removeMonitor(ownerId, id, monitorId) {
      return mutate(ownerId, id, async (tx) => {
        if (!(await tx.deleteMonitor(id, monitorId))) throw monitorNotFound();
        await writeOrder(
          tx,
          id,
          (await tx.listMonitors(id)).map((m) => m.monitorId),
        );
      });
    },

    renameMonitor(ownerId, id, monitorId, displayName) {
      return mutate(ownerId, id, async (tx) => {
        if (!(await tx.updateMonitor(id, monitorId, { displayName }))) throw monitorNotFound();
      });
    },

    reorderMonitors(ownerId, id, monitorIds) {
      return mutate(ownerId, id, async (tx) => {
        const current = (await tx.listMonitors(id)).map((m) => m.monitorId);
        const wanted = monitorIds.map((m) => m.toLowerCase());
        const same = wanted.length === current.length && current.every((m) => wanted.includes(m));
        if (!same) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
            { path: 'monitorIds', message: "List exactly the page's monitors, each once" },
          ]);
        }
        await writeOrder(tx, id, wanted);
      });
    },

    async preview(ownerId, id) {
      return repository.transaction(
        async (tx) => buildPublicView(tx, await loadOwned(tx, ownerId, id)),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },

    async publicView(slug) {
      return repository.transaction(
        async (tx) => {
          const page = await tx.findPublishedBySlug(slug);
          if (!page) throw statusPageNotFound();
          return buildPublicView(tx, page);
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}
