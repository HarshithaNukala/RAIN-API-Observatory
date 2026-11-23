import { randomUUID } from 'node:crypto';
import {
  CreateStatusPageSchema,
  UpdateStatusPageSchema,
  type PublicServiceStatus,
} from '@rain/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProfileStore } from '../db/profiles.js';
import type { IncidentRow, MonitorRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  createInMemoryMonitorRepository,
  type InMemoryMonitorRepository,
} from '../test-support/in-memory-monitor-repository.js';
import {
  createInMemoryStatusPageRepository,
  type InMemoryStatusPageRepository,
} from '../test-support/in-memory-status-page-repository.js';
import {
  availabilityDays,
  overallStatus,
  publicIncident,
  publicServiceStatus,
  slugFromTitle,
  slugWithSuffix,
} from './public-status.js';
import { createStatusPageService, type StatusPageService } from './status-page-service.js';

const NOW = new Date('2026-11-19T10:30:00.000Z');
const owner = randomUUID();
const other = randomUUID();
const profiles: ProfileStore = {
  ensure: async (id) => ({
    id,
    displayName: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }),
};

describe('overall status', () => {
  const of = (...statuses: PublicServiceStatus[]) =>
    overallStatus(statuses.map((status) => ({ status })));
  it.each([
    [['HEALTHY', 'DOWN', 'DEGRADED'], 'DOWN'],
    [['HEALTHY', 'DEGRADED'], 'DEGRADED'],
    [['HEALTHY', 'HEALTHY'], 'HEALTHY'],
    [['HEALTHY', 'UNKNOWN'], 'HEALTHY'],
    [['UNKNOWN', 'UNKNOWN'], 'UNKNOWN'],
    [[], 'UNKNOWN'],
    [['PAUSED', 'PAUSED'], 'UNKNOWN'],
    [['PAUSED', 'HEALTHY'], 'HEALTHY'],
  ] as const)('%j → %s', (statuses, expected) => {
    expect(of(...statuses)).toBe(expected);
  });

  it('excludes paused services, whatever their last status was', () => {
    expect(publicServiceStatus('DOWN', false)).toBe('PAUSED');
    expect(publicServiceStatus('DOWN', true)).toBe('DOWN');
    expect(
      overallStatus([{ status: publicServiceStatus('DOWN', false) }, { status: 'HEALTHY' }]),
    ).toBe('HEALTHY');
  });
});

describe('public incident text', () => {
  const base = { severity: 'HIGH' as const, startedAt: new Date('2026-11-19T09:00:00Z') };
  it('is generated from the public service name, never internal text', () => {
    expect(publicIncident({ ...base, status: 'OPEN', resolvedAt: null }, 'Checkout', 'i1')).toEqual(
      {
        key: 'i1',
        title: 'Checkout disruption',
        serviceName: 'Checkout',
        status: 'INVESTIGATING',
        severity: 'HIGH',
        startedAt: '2026-11-19T09:00:00.000Z',
        resolvedAt: null,
        summary: 'Checkout is unavailable or failing checks. We are investigating.',
      },
    );
    expect(
      publicIncident({ ...base, status: 'ACKNOWLEDGED', resolvedAt: null }, 'Checkout', 'i1')
        .status,
    ).toBe('IDENTIFIED');
    const resolved = publicIncident(
      { ...base, status: 'RESOLVED', resolvedAt: new Date('2026-11-19T10:35:00Z') },
      'Checkout',
      'i1',
    );
    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      summary: 'Checkout was unavailable or failing checks. Resolved after 1 h 35 min.',
    });
  });
});

describe('daily availability', () => {
  it('reports null for days without checks and sums the window', () => {
    const today = Date.parse('2026-11-19T00:00:00Z');
    const { days, availabilityPercent } = availabilityDays(
      [
        { dayMs: today, eligible: 10, successful: 9 },
        { dayMs: today - 86_400_000, eligible: 10, successful: 10 },
      ],
      NOW,
    );
    expect(days).toHaveLength(30);
    expect(days[0]!.date).toBe('2026-10-21');
    expect(days.at(-1)).toEqual({ date: '2026-11-19', availabilityPercent: 90 });
    expect(days.at(-2)).toEqual({ date: '2026-11-18', availabilityPercent: 100 });
    expect(days.filter((d) => d.availabilityPercent === null)).toHaveLength(28);
    expect(availabilityPercent).toBe(95);
    expect(availabilityDays([], NOW).availabilityPercent).toBeNull();
  });
});

describe('slugs', () => {
  it('derives a valid slug from a title, with a random suffix when needed', () => {
    expect(slugFromTitle('Acme API — Status!')).toBe('acme-api-status');
    expect(slugFromTitle('Ünïcode Café')).toBe('unicode-cafe');
    expect(slugFromTitle('!!')).toBe('status');
    expect(slugFromTitle('app')).toBe('status');
    expect(slugWithSuffix('acme')).toMatch(/^acme-[0-9a-f]{8}$/);
  });
});

describe('status page service', () => {
  let repo: InMemoryMonitorRepository;
  let pages: InMemoryStatusPageRepository;
  let service: StatusPageService;

  beforeEach(() => {
    repo = createInMemoryMonitorRepository();
    pages = createInMemoryStatusPageRepository(repo);
    service = createStatusPageService({ repository: pages, profiles, now: () => NOW });
  });

  const monitor = (overrides: Partial<MonitorRow> = {}) =>
    repo.insert({
      ownerId: owner,
      name: 'payments-prod-eu (internal)',
      url: 'https://internal.example.com/health?token=secret-123',
      method: 'GET',
      expectedStatusCode: 200,
      timeoutMs: 10_000,
      latencyThresholdMs: 1000,
      checkIntervalSeconds: 60,
      ...overrides,
    });
  const create = (title = 'Acme Status', slug?: string) =>
    service.create(owner, CreateStatusPageSchema.parse({ title, ...(slug && { slug }) }));

  async function expectError(promise: Promise<unknown>, status: number, code: string) {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status, code });
  }

  it('creates unpublished pages with a generated or chosen unique slug', async () => {
    const a = await create('Acme Status');
    expect(a).toMatchObject({
      title: 'Acme Status',
      slug: 'acme-status',
      published: false,
      publishedAt: null,
      monitors: [],
    });
    const b = await create('Acme Status');
    expect(b.slug).toMatch(/^acme-status-[0-9a-f]{8}$/);
    await expectError(create('Other', 'acme-status'), 409, 'STATUS_PAGE_SLUG_TAKEN');
    expect((await create('Mine', 'my-page')).slug).toBe('my-page');
  });

  it('enforces the per-owner page limit', async () => {
    for (let i = 0; i < 10; i++) await create(`Page ${i}`);
    await expectError(create('One too many'), 409, 'STATUS_PAGE_LIMIT_REACHED');
  });

  it('edits title, description and slug; a taken slug is rejected', async () => {
    const page = await create('Acme Status');
    await create('Taken', 'taken-slug');
    const edited = await service.update(
      owner,
      page.id,
      UpdateStatusPageSchema.parse({ title: 'Acme', description: 'Live status', slug: 'acme' }),
    );
    expect(edited).toMatchObject({ title: 'Acme', description: 'Live status', slug: 'acme' });
    await expectError(
      service.update(owner, page.id, { slug: 'taken-slug' }),
      409,
      'STATUS_PAGE_SLUG_TAKEN',
    );
    expect(
      (await service.update(owner, page.id, UpdateStatusPageSchema.parse({ description: '' })))
        .description,
    ).toBeNull();
  });

  it('adds only the owner’s monitors, once, in order; renames, reorders and removes them', async () => {
    const page = await create();
    const a = await monitor({ name: 'A' });
    const b = await monitor({ name: 'B' });
    const c = await monitor({ name: 'C' });
    const foreign = await monitor({ ownerId: other });
    await service.addMonitor(owner, page.id, { monitorId: a.id });
    await service.addMonitor(owner, page.id, { monitorId: b.id, displayName: 'Payments' });
    const added = await service.addMonitor(owner, page.id, { monitorId: c.id });
    expect(added.monitors.map((m) => [m.displayName, m.position])).toEqual([
      ['A', 0],
      ['Payments', 1],
      ['C', 2],
    ]);
    await expectError(
      service.addMonitor(owner, page.id, { monitorId: a.id }),
      409,
      'STATUS_PAGE_MONITOR_EXISTS',
    );
    await expectError(
      service.addMonitor(owner, page.id, { monitorId: foreign.id }),
      404,
      'MONITOR_NOT_FOUND',
    );
    await expectError(
      service.addMonitor(owner, page.id, { monitorId: randomUUID() }),
      404,
      'MONITOR_NOT_FOUND',
    );

    const renamed = await service.renameMonitor(owner, page.id, a.id, 'Website');
    expect(renamed.monitors[0]!.displayName).toBe('Website');
    const reordered = await service.reorderMonitors(owner, page.id, [c.id, a.id, b.id]);
    expect(reordered.monitors.map((m) => m.displayName)).toEqual(['C', 'Website', 'Payments']);
    await expectError(
      service.reorderMonitors(owner, page.id, [c.id, a.id]),
      400,
      'VALIDATION_ERROR',
    );
    await expectError(
      service.reorderMonitors(owner, page.id, [c.id, a.id, foreign.id]),
      400,
      'VALIDATION_ERROR',
    );

    const removed = await service.removeMonitor(owner, page.id, a.id);
    expect(removed.monitors.map((m) => [m.displayName, m.position])).toEqual([
      ['C', 0],
      ['Payments', 1],
    ]);
  });

  it('enforces the per-page monitor limit', async () => {
    const page = await create();
    for (let i = 0; i < 50; i++) {
      await service.addMonitor(owner, page.id, {
        monitorId: (await monitor({ name: `M${i}` })).id,
      });
    }
    await expectError(
      service.addMonitor(owner, page.id, { monitorId: (await monitor()).id }),
      409,
      'STATUS_PAGE_MONITOR_LIMIT_REACHED',
    );
  });

  it("isolates owners: someone else's page is not found for every operation", async () => {
    const page = await create();
    const m = await monitor();
    await expectError(service.get(other, page.id), 404, 'STATUS_PAGE_NOT_FOUND');
    await expectError(service.update(other, page.id, { title: 'x' }), 404, 'STATUS_PAGE_NOT_FOUND');
    await expectError(service.setPublished(other, page.id, true), 404, 'STATUS_PAGE_NOT_FOUND');
    await expectError(service.remove(other, page.id), 404, 'STATUS_PAGE_NOT_FOUND');
    await expectError(
      service.addMonitor(other, page.id, { monitorId: m.id }),
      404,
      'STATUS_PAGE_NOT_FOUND',
    );
    await expectError(service.preview(other, page.id), 404, 'STATUS_PAGE_NOT_FOUND');
    expect((await service.list(other)).items).toEqual([]);
  });

  it('publishes and unpublishes; the public view exists only while published', async () => {
    const page = await create('Acme', 'acme');
    await expectError(service.publicView('acme'), 404, 'STATUS_PAGE_NOT_FOUND');
    const published = await service.setPublished(owner, page.id, true);
    expect(published).toMatchObject({ published: true, publishedAt: NOW.toISOString() });
    expect((await service.publicView('acme')).title).toBe('Acme');
    await service.setPublished(owner, page.id, false);
    await expectError(service.publicView('acme'), 404, 'STATUS_PAGE_NOT_FOUND');
    // Preview works either way, for the owner.
    expect((await service.preview(owner, page.id)).title).toBe('Acme');
    await expectError(service.publicView('no-such-page'), 404, 'STATUS_PAGE_NOT_FOUND');
  });

  it('deleting a page removes its monitor selections; deleting a monitor removes it from pages', async () => {
    const page = await create();
    const a = await monitor();
    const b = await monitor();
    await service.addMonitor(owner, page.id, { monitorId: a.id });
    await service.addMonitor(owner, page.id, { monitorId: b.id });
    await repo.delete(owner, a.id);
    expect((await service.get(owner, page.id)).monitors).toHaveLength(1);
    await service.remove(owner, page.id);
    expect(pages.pageMonitors.filter((m) => m.statusPageId === page.id)).toEqual([]);
  });

  describe('public view', () => {
    function incident(m: MonitorRow, overrides: Partial<IncidentRow> = {}) {
      repo.incidents.push({
        id: randomUUID(),
        monitorId: m.id,
        ownerId: m.ownerId,
        title: `${m.name} is down`,
        description: 'GET https://internal.example.com/health: connection refused (10.0.0.7)',
        severity: 'HIGH',
        status: 'OPEN',
        startedAt: new Date(NOW.getTime() - 3600_000),
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        triggerCheckId: randomUUID(),
        resolvedByCheckId: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
      });
    }
    function check(
      m: MonitorRow,
      minutesAgo: number,
      outcome: 'SUCCESS' | 'FAILURE',
      reason: string | null = null,
    ) {
      repo.checks.push({
        id: randomUUID(),
        monitorId: m.id,
        attemptId: randomUUID(),
        source: 'SCHEDULED',
        checkedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
        outcome,
        statusCode: outcome === 'SUCCESS' ? 200 : null,
        latencyMs: outcome === 'SUCCESS' ? 50 : null,
        failureReason: outcome === 'FAILURE' ? (reason ?? 'TIMEOUT') : null,
        errorMessage: null,
        createdAt: NOW,
      });
    }

    it('shows selected services under public names with status, last check and availability', async () => {
      const page = await create('Acme', 'acme');
      const api = await monitor({
        currentStatus: 'DOWN',
        lastCheckedAt: new Date(NOW.getTime() - 60_000),
      });
      const web = await monitor({ name: 'web-frontend-internal', currentStatus: 'HEALTHY' });
      const paused = await monitor({ name: 'batch', currentStatus: 'DOWN', enabled: false });
      const notSelected = await monitor({ name: 'secret-admin', currentStatus: 'DOWN' });
      await service.addMonitor(owner, page.id, { monitorId: api.id, displayName: 'API' });
      await service.addMonitor(owner, page.id, { monitorId: web.id, displayName: 'Website' });
      await service.addMonitor(owner, page.id, { monitorId: paused.id, displayName: 'Batch jobs' });
      await service.setPublished(owner, page.id, true);
      check(api, 10, 'SUCCESS');
      check(api, 20, 'FAILURE');
      check(api, 30, 'FAILURE', 'BLOCKED_DESTINATION'); // RAIN's refusal: excluded.
      incident(api);
      incident(notSelected);
      incident(api, {
        status: 'RESOLVED',
        startedAt: new Date(NOW.getTime() - 40 * 86_400_000),
        resolvedAt: new Date(NOW.getTime() - 40 * 86_400_000 + 60_000),
      });

      const view = await service.publicView('acme');
      expect(view.overallStatus).toBe('DOWN');
      expect(view.services.map((s) => [s.key, s.name, s.status, s.availabilityPercent])).toEqual([
        ['s1', 'API', 'DOWN', 50],
        ['s2', 'Website', 'HEALTHY', null],
        ['s3', 'Batch jobs', 'PAUSED', null],
      ]);
      expect(view.services[0]!.lastCheckedAt).toBe(new Date(NOW.getTime() - 60_000).toISOString());
      // Only the selected monitor's recent incident; the 40-day-old one is outside the window.
      expect(view.incidents).toEqual([
        expect.objectContaining({
          key: 'i1',
          title: 'API disruption',
          serviceName: 'API',
          status: 'INVESTIGATING',
        }),
      ]);
    });

    it('never exposes database IDs, internal names, URLs, descriptions or credentials', async () => {
      const page = await create('Acme', 'acme');
      const api = await monitor();
      await service.addMonitor(owner, page.id, { monitorId: api.id, displayName: 'API' });
      await service.setPublished(owner, page.id, true);
      incident(api);
      check(api, 5, 'SUCCESS');
      const json = JSON.stringify(await service.publicView('acme'));
      for (const secret of [
        api.id,
        page.id,
        owner,
        'internal',
        'secret-123',
        'payments-prod-eu',
        '10.0.0.7',
        'connection refused',
        'https://',
      ]) {
        expect(json).not.toContain(secret);
      }
      expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    });

    it('a page with no monitors, or none checked yet, is UNKNOWN', async () => {
      const page = await create('Acme', 'acme');
      await service.setPublished(owner, page.id, true);
      expect((await service.publicView('acme')).overallStatus).toBe('UNKNOWN');
      await service.addMonitor(owner, page.id, { monitorId: (await monitor()).id });
      expect((await service.publicView('acme')).overallStatus).toBe('UNKNOWN');
    });
  });
});
