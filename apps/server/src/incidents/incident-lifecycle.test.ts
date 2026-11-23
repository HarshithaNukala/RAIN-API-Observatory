import { randomBytes, randomUUID } from 'node:crypto';
import { CreateMonitorSchema, type CreateMonitorInput, type IncidentListQuery } from '@rain/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.js';
import type { ProfileStore } from '../db/profiles.js';
import { AppError } from '../errors.js';
import type { CheckExecution } from '../monitoring/executor.js';
import { createMonitorExecutor } from '../monitoring/executor.js';
import { createMonitoringWorker } from '../monitoring/worker-engine.js';
import { createMonitorService, type MonitorService } from '../monitors/monitor-service.js';
import { createInMemoryIncidentRepository } from '../test-support/in-memory-incident-repository.js';
import {
  createInMemoryMonitorRepository,
  type InMemoryMonitorRepository,
} from '../test-support/in-memory-monitor-repository.js';
import {
  createInMemoryMonitoringStore,
  type InMemoryMonitoringStore,
} from '../test-support/in-memory-monitoring-store.js';
import { startLocalTarget, type LocalTarget } from '../test-support/local-target.js';
import { createIncidentService, type IncidentService } from './incident-service.js';

/**
 * The incident lifecycle end to end, without a database: the real worker, executor and SSRF-safe
 * transport against a local HTTP server; the monitor and incident services as the API uses them;
 * in-memory stores sharing one set of rows. SQL behaviour (partial unique index, row locks,
 * ON CONFLICT, the append-only trigger) is in tests/integration/incidents.test.ts.
 */

const profiles: ProfileStore = {
  ensure: async (id) => ({
    id,
    displayName: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }),
};
const owner = randomUUID();
const stranger = randomUUID();
const secretBox = createSecretBox({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });

let clock: number;
const now = () => new Date(clock);
let repo: InMemoryMonitorRepository;
let store: InMemoryMonitoringStore;
let monitorsSvc: MonitorService;
let incidentsSvc: IncidentService;
let target: LocalTarget;

const listAll = (query: Partial<IncidentListQuery> = {}, ownerId = owner) =>
  incidentsSvc.list(ownerId, { limit: 20, ...query });

beforeEach(async () => {
  clock = Date.parse('2026-11-18T10:00:00.000Z');
  repo = createInMemoryMonitorRepository();
  store = createInMemoryMonitoringStore(repo, { now });
  monitorsSvc = createMonitorService({
    repository: repo,
    profiles,
    secretBox,
    maxMonitorsPerUser: 50,
    now,
  });
  incidentsSvc = createIncidentService({ repository: createInMemoryIncidentRepository(repo), now });
  target = await startLocalTarget();
});

afterEach(async () => {
  await target.close();
});

const create = (overrides: Partial<CreateMonitorInput> = {}) =>
  monitorsSvc.create(
    owner,
    CreateMonitorSchema.parse({
      name: 'Payments',
      url: 'http://api.example.com/health',
      checkIntervalSeconds: 60,
      latencyThresholdMs: 1000,
      ...overrides,
    }),
  );

const worker = () =>
  createMonitoringWorker({
    store,
    executor: createMonitorExecutor({
      transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
      secretBox,
      now,
    }),
    logger: pino({ level: 'silent' }),
    now,
  });

/** Runs one scheduled check with the given response, then moves to the next slot. */
async function checkWith(status: number, options: { delayMs?: number } = {}) {
  target.reply('/health', 'GET', status, '', {}, { delayMs: options.delayMs ?? 0 });
  expect(await worker().pollOnce()).toBe(1);
  clock += 60_000;
}

const monitorStatus = (id: string) => repo.monitors.find((m) => m.id === id)!.currentStatus;

describe('automatic lifecycle', () => {
  it('no incident on the first failure; one on the transition to DOWN, with the trigger check', async () => {
    const m = await create();
    await checkWith(200);
    await checkWith(503);
    expect(monitorStatus(m.id)).toBe('DEGRADED');
    expect((await listAll()).total).toBe(0);

    await checkWith(500);
    expect(monitorStatus(m.id)).toBe('DOWN');
    const { items } = await listAll();
    expect(items).toHaveLength(1);
    const [incident] = items;
    const trigger = repo.checks.find((c) => c.statusCode === 500)!;
    expect(incident).toMatchObject({
      title: 'Payments is down',
      status: 'OPEN',
      severity: 'HIGH',
      startedAt: trigger.checkedAt.toISOString(),
      triggerCheckId: trigger.id,
      monitor: { id: m.id, name: 'Payments', currentStatus: 'DOWN', enabled: true },
    });
    expect(incident!.description).toMatch(/2 consecutive failed checks.*HTTP 500/);

    const timeline = await incidentsSvc.events(owner, incident!.id, { limit: 100 });
    expect(timeline.items).toEqual([
      expect.objectContaining({ type: 'INCIDENT_CREATED', actor: 'SYSTEM', checkId: trigger.id }),
    ]);
  });

  it('repeated failures during an open incident create no duplicates and no extra events', async () => {
    await create();
    for (let i = 0; i < 6; i++) await checkWith(503);
    expect((await listAll()).total).toBe(1);
    expect(repo.incidentEvents).toHaveLength(1);
  });

  it('stays open after the first recovery success, resolves after the second', async () => {
    const m = await create();
    await checkWith(503);
    await checkWith(503);
    await checkWith(200);
    expect(monitorStatus(m.id)).toBe('DEGRADED');
    const [stillOpen] = (await listAll()).items;
    expect(stillOpen!.status).toBe('OPEN');

    await checkWith(200);
    const [resolved] = (await listAll()).items;
    const lastCheck = repo.checks.at(-1)!;
    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      resolvedAt: lastCheck.checkedAt.toISOString(),
      resolvedByCheckId: lastCheck.id,
      monitor: { currentStatus: 'HEALTHY' },
    });
    const types = (await incidentsSvc.events(owner, resolved!.id, { limit: 100 })).items.map(
      (e) => e.type,
    );
    expect(types).toEqual(['INCIDENT_CREATED', 'INCIDENT_RESOLVED']);
  });

  it('slow but expected responses count toward recovery; the monitor stays DEGRADED', async () => {
    const m = await create({ timeoutMs: 5000, latencyThresholdMs: 1000 });
    await checkWith(503);
    await checkWith(503);
    await checkWith(200, { delayMs: 1100 });
    await checkWith(200, { delayMs: 1100 });
    expect(monitorStatus(m.id)).toBe('DEGRADED');
    expect((await listAll()).items[0]!.status).toBe('RESOLVED');
  });

  it('recovery interrupted by a failure keeps the incident open', async () => {
    await create();
    await checkWith(503);
    await checkWith(503);
    await checkWith(200);
    await checkWith(503); // Flap: counter reset, monitor DEGRADED, incident still open.
    await checkWith(200);
    expect((await listAll()).items[0]!.status).toBe('OPEN');
    await checkWith(200);
    expect((await listAll()).items[0]!.status).toBe('RESOLVED');
    expect((await listAll()).total).toBe(1);
  });

  it('a new outage after resolution opens a new incident; the old one keeps its history', async () => {
    await create();
    for (const status of [503, 503, 200, 200]) await checkWith(status);
    const [first] = (await listAll()).items;
    for (const status of [500, 500]) await checkWith(status);

    const { items, total } = await listAll();
    expect(total).toBe(2);
    expect(items.map((i) => i.status)).toEqual(['OPEN', 'RESOLVED']);
    expect(items[1]!.id).toBe(first!.id);
    const oldTimeline = await incidentsSvc.events(owner, first!.id, { limit: 100 });
    expect(oldTimeline.items.map((e) => e.type)).toEqual(['INCIDENT_CREATED', 'INCIDENT_RESOLVED']);
  });

  it('SSRF refusals never open an incident', async () => {
    await create();
    target.setDnsAnswers([{ address: '10.1.2.3', family: 4 }]);
    for (let i = 0; i < 4; i++) {
      expect(await worker().pollOnce()).toBe(1);
      clock += 60_000;
    }
    expect(repo.checks.every((c) => c.failureReason === 'BLOCKED_DESTINATION')).toBe(true);
    expect((await listAll()).total).toBe(0);
  });

  it('a monitor paused while DOWN keeps its incident open; nothing resolves it while paused', async () => {
    const m = await create();
    await checkWith(503);
    await checkWith(503);
    await monitorsSvc.pause(owner, m.id);
    clock += 10 * 60_000;
    expect(await worker().pollOnce()).toBe(0);
    expect((await listAll()).items[0]!.status).toBe('OPEN');
  });
});

describe('persistence safety', () => {
  const failing: CheckExecution = {
    checkedAt: new Date(0),
    result: { outcome: 'FAILURE', statusCode: null, latencyMs: null, failureReason: 'TIMEOUT' },
    errorMessage: 'timeout',
    response: null,
  };

  async function downToThreshold(monitorId: string) {
    const row = repo.monitors.find((x) => x.id === monitorId)!;
    Object.assign(row, { currentStatus: 'DEGRADED', consecutiveFailures: 1 });
  }

  it('a failure while writing the incident rolls back the check, the incident and the health change', async () => {
    const m = await create();
    await downToThreshold(m.id);
    const [claim] = await store.claim(10, 90);
    store.failNext('incident');
    await expect(store.complete(claim!, { ...failing, checkedAt: now() })).rejects.toThrow();
    expect(repo.checks).toHaveLength(0);
    expect(repo.incidents).toHaveLength(0);
    expect(repo.incidentEvents).toHaveLength(0);
    expect(monitorStatus(m.id)).toBe('DEGRADED');
    // The lease is still ours, so the worker would release it and a later check retries.
    expect(await store.release(claim!)).toBe(true);
  });

  it('the worker releases the lease when incident creation fails, then a later check opens it', async () => {
    const m = await create();
    await downToThreshold(m.id);
    store.failNext('incident');
    target.reply('/health', 'GET', 503);
    await worker().pollOnce();
    expect(repo.incidents).toHaveLength(0);
    expect(repo.monitors.find((x) => x.id === m.id)!.leaseToken).toBeNull();

    clock += 60_000;
    await checkWith(503);
    expect(repo.incidents).toHaveLength(1);
  });

  it('a duplicate completion of the same attempt creates no duplicate incident or event', async () => {
    const m = await create();
    await downToThreshold(m.id);
    const [claim] = await store.claim(10, 90);
    const execution = { ...failing, checkedAt: now() };
    expect(await store.complete(claim!, execution)).toMatchObject({
      incident: { action: 'OPENED' },
    });
    repo.monitors.find((x) => x.id === m.id)!.leaseToken = claim!.leaseToken;
    expect(await store.complete(claim!, execution)).toEqual({
      recorded: false,
      reason: 'DUPLICATE_ATTEMPT',
    });
    expect(repo.incidents).toHaveLength(1);
    expect(repo.incidentEvents).toHaveLength(1);
  });

  it('a stale worker cannot open or resolve anything after losing its lease', async () => {
    const m = await create();
    await downToThreshold(m.id);
    const [stale] = await store.claim(10, 90);
    clock += 91_000;
    const [fresh] = await store.claim(10, 90);
    expect(await store.complete(fresh!, { ...failing, checkedAt: now() })).toMatchObject({
      incident: { action: 'OPENED' },
    });
    expect(await store.complete(stale!, { ...failing, checkedAt: now() })).toEqual({
      recorded: false,
      reason: 'LEASE_LOST',
    });
    expect(repo.incidents).toHaveLength(1);
    expect(monitorStatus(m.id)).toBe('DOWN');
  });

  it('deleting a monitor removes its incidents and their timelines', async () => {
    const m = await create();
    await checkWith(503);
    await checkWith(503);
    await monitorsSvc.remove(owner, m.id);
    expect(repo.incidents).toHaveLength(0);
    expect(repo.incidentEvents).toHaveLength(0);
  });
});

describe('incident service', () => {
  async function openIncident(name = 'Payments') {
    const m = await create({ name });
    // Park earlier monitors so each poll checks only this one.
    for (const other of repo.monitors) {
      if (other.id !== m.id) other.nextCheckAt = new Date(clock + 86_400_000);
    }
    await checkWith(503);
    await checkWith(503);
    const { items } = await listAll({ monitorId: m.id });
    return { monitor: m, incident: items[0]! };
  }

  async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status, code });
  }

  it('acknowledges an OPEN incident once, recording who, when and a timeline event', async () => {
    const { incident } = await openIncident();
    clock += 5000;
    const acked = await incidentsSvc.acknowledge(owner, incident.id);
    expect(acked).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedAt: now().toISOString(),
      acknowledgedBy: owner,
    });
    const events = (await incidentsSvc.events(owner, incident.id, { limit: 100 })).items;
    expect(events.map((e) => [e.type, e.actor, e.actorId])).toEqual([
      ['INCIDENT_CREATED', 'SYSTEM', null],
      ['INCIDENT_ACKNOWLEDGED', 'USER', owner],
    ]);

    await expectAppError(
      incidentsSvc.acknowledge(owner, incident.id),
      409,
      'INCIDENT_ALREADY_ACKNOWLEDGED',
    );
    expect(repo.incidentEvents).toHaveLength(2);
  });

  it('an acknowledged incident still resolves automatically on recovery', async () => {
    const { incident } = await openIncident();
    await incidentsSvc.acknowledge(owner, incident.id);
    await checkWith(200);
    await checkWith(200);
    const resolved = await incidentsSvc.get(owner, incident.id);
    expect(resolved).toMatchObject({ status: 'RESOLVED', acknowledgedBy: owner });
    const types = (await incidentsSvc.events(owner, incident.id, { limit: 100 })).items.map(
      (e) => e.type,
    );
    expect(types).toEqual(['INCIDENT_CREATED', 'INCIDENT_ACKNOWLEDGED', 'INCIDENT_RESOLVED']);
  });

  it('rejects acknowledging a resolved incident', async () => {
    const { incident } = await openIncident();
    await checkWith(200);
    await checkWith(200);
    await expectAppError(
      incidentsSvc.acknowledge(owner, incident.id),
      409,
      'INCIDENT_ALREADY_RESOLVED',
    );
  });

  it("another user can't see, acknowledge, update or read the timeline of someone else's incident", async () => {
    const { incident } = await openIncident();
    await expectAppError(incidentsSvc.get(stranger, incident.id), 404, 'INCIDENT_NOT_FOUND');
    await expectAppError(
      incidentsSvc.acknowledge(stranger, incident.id),
      404,
      'INCIDENT_NOT_FOUND',
    );
    await expectAppError(
      incidentsSvc.update(stranger, incident.id, { severity: 'LOW' }),
      404,
      'INCIDENT_NOT_FOUND',
    );
    await expectAppError(
      incidentsSvc.events(stranger, incident.id, { limit: 10 }),
      404,
      'INCIDENT_NOT_FOUND',
    );
    expect((await listAll({}, stranger)).total).toBe(0);
    expect(await incidentsSvc.counts(stranger)).toEqual({
      total: 0,
      open: 0,
      acknowledged: 0,
      resolved: 0,
    });
    expect((await incidentsSvc.get(owner, incident.id)).status).toBe('OPEN');
  });

  it('updates title, description and severity with one UPDATED event that does not echo the text', async () => {
    const { incident } = await openIncident();
    const updated = await incidentsSvc.update(owner, incident.id, {
      title: 'Card payments failing',
      description: 'Upstream bank API returns 503',
      severity: 'CRITICAL',
    });
    expect(updated).toMatchObject({
      title: 'Card payments failing',
      severity: 'CRITICAL',
      status: 'OPEN',
    });
    const last = (await incidentsSvc.events(owner, incident.id, { limit: 100 })).items.at(-1)!;
    expect(last).toMatchObject({ type: 'INCIDENT_UPDATED', actor: 'USER' });
    expect(last.description).toBe(
      'Severity changed from HIGH to CRITICAL. Title changed. Description updated.',
    );
    expect(last.description).not.toContain('bank');

    // No-op updates record nothing.
    await incidentsSvc.update(owner, incident.id, { severity: 'CRITICAL' });
    expect(repo.incidentEvents.filter((e) => e.eventType === 'INCIDENT_UPDATED')).toHaveLength(1);
  });

  it('filters by status (including ACTIVE), severity and monitor, and counts by status', async () => {
    const a = await openIncident('A');
    const b = await openIncident('B');
    await incidentsSvc.acknowledge(owner, b.incident.id);
    await incidentsSvc.update(owner, a.incident.id, { severity: 'CRITICAL' });

    expect((await listAll({ status: 'OPEN' })).items.map((i) => i.monitor.name)).toEqual(['A']);
    expect((await listAll({ status: 'ACKNOWLEDGED' })).items.map((i) => i.monitor.name)).toEqual([
      'B',
    ]);
    expect((await listAll({ status: 'ACTIVE' })).total).toBe(2);
    expect((await listAll({ status: 'RESOLVED' })).total).toBe(0);
    expect((await listAll({ severity: 'CRITICAL' })).items.map((i) => i.id)).toEqual([
      a.incident.id,
    ]);
    expect((await listAll({ monitorId: b.monitor.id })).items.map((i) => i.id)).toEqual([
      b.incident.id,
    ]);
    expect(await incidentsSvc.counts(owner)).toEqual({
      total: 2,
      open: 1,
      acknowledged: 1,
      resolved: 0,
    });
    expect(await incidentsSvc.counts(owner, a.monitor.id)).toEqual({
      total: 1,
      open: 1,
      acknowledged: 0,
      resolved: 0,
    });
  });

  it('paginates newest first with a cursor', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await openIncident(name);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await incidentsSvc.list(owner, { limit: 2, cursor });
      expect(page.total).toBe(5);
      seen.push(...page.items.map((i) => i.monitor.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['E', 'D', 'C', 'B', 'A']);
  });

  it('returns the timeline oldest first, paginated', async () => {
    const { incident } = await openIncident();
    clock += 1000;
    await incidentsSvc.acknowledge(owner, incident.id);
    clock += 1000;
    await incidentsSvc.update(owner, incident.id, { severity: 'LOW' });
    const first = await incidentsSvc.events(owner, incident.id, { limit: 2 });
    expect(first.items.map((e) => e.type)).toEqual(['INCIDENT_CREATED', 'INCIDENT_ACKNOWLEDGED']);
    const rest = await incidentsSvc.events(owner, incident.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(rest.items.map((e) => e.type)).toEqual(['INCIDENT_UPDATED']);
    expect(rest.nextCursor).toBeNull();
  });

  it('never exposes the URL, headers or request content of the monitor', async () => {
    const { incident } = await openIncident();
    const json = JSON.stringify([
      await incidentsSvc.get(owner, incident.id),
      await incidentsSvc.events(owner, incident.id, { limit: 100 }),
    ]);
    expect(json).not.toContain('"url"');
    expect(json).not.toContain('headers');
  });
});
