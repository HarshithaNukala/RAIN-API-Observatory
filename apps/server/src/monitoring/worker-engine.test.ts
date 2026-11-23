import { randomBytes, randomUUID } from 'node:crypto';
import { CreateMonitorSchema, type CreateMonitorInput } from '@rain/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.js';
import type { ProfileStore } from '../db/profiles.js';
import { createMonitorService, type MonitorService } from '../monitors/monitor-service.js';
import {
  createInMemoryMonitorRepository,
  type InMemoryMonitorRepository,
} from '../test-support/in-memory-monitor-repository.js';
import {
  createInMemoryMonitoringStore,
  type InMemoryMonitoringStore,
} from '../test-support/in-memory-monitoring-store.js';
import { startLocalTarget, type LocalTarget } from '../test-support/local-target.js';
import {
  OUTBOUND_DISABLED,
  createMonitorExecutor,
  type CheckExecution,
  type MonitorExecutor,
} from './executor.js';
import {
  createMonitoringWorker,
  validateWorkerSettings,
  type WorkerSettings,
} from './worker-engine.js';

/**
 * End-to-end engine tests: the real monitor service (as the API uses it), the real executor and
 * SSRF-safe transport against a local HTTP server, and the worker loop, sharing an in-memory store.
 * PostgreSQL-specific behaviour (SKIP LOCKED, constraints, ON CONFLICT) is in
 * tests/integration/monitoring-engine.test.ts.
 */

const SECRET = 'Bearer sk_live_engine-secret-123';
const profiles: ProfileStore = {
  ensure: async (id) => ({
    id,
    displayName: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }),
};
const owner = randomUUID();
const silent = pino({ level: 'silent' });

let clock: number;
const now = () => new Date(clock);
const advance = (ms: number) => {
  clock += ms;
};

let repo: InMemoryMonitorRepository;
let store: InMemoryMonitoringStore;
let target: LocalTarget;
let service: MonitorService;
const secretBox = createSecretBox({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });

function executor(): MonitorExecutor {
  return createMonitorExecutor({
    transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
    secretBox,
    now,
  });
}

function worker(options: { settings?: Partial<WorkerSettings>; executor?: MonitorExecutor } = {}) {
  return createMonitoringWorker({
    store,
    executor: options.executor ?? executor(),
    logger: silent,
    settings: { pollIntervalMs: 100, maxBackoffMs: 400, ...options.settings },
    now,
  });
}

const create = (overrides: Partial<CreateMonitorInput> = {}) =>
  service.create(
    owner,
    CreateMonitorSchema.parse({
      name: 'Payments',
      url: 'http://api.example.com/health',
      checkIntervalSeconds: 60,
      ...overrides,
    }),
  );
const row = (id: string) => repo.monitors.find((m) => m.id === id)!;
const checksOf = (id: string) => repo.checks.filter((c) => c.monitorId === id);

beforeEach(async () => {
  clock = Date.parse('2026-11-18T10:00:00.000Z');
  repo = createInMemoryMonitorRepository();
  store = createInMemoryMonitoringStore(repo, { now });
  service = createMonitorService({
    repository: repo,
    profiles,
    secretBox,
    maxMonitorsPerUser: 50,
    now,
  });
  target = await startLocalTarget();
});

afterEach(async () => {
  await target.close();
});

describe('monitor lifecycle', () => {
  it('register → schedule → claim → execute → record → health → next check → visible in the API', async () => {
    const monitor = await create({ headers: [{ name: 'Authorization', value: SECRET }] });
    expect(monitor.currentStatus).toBe('UNKNOWN');
    target.reply('/health', 'GET', 200, 'ok');

    expect(await worker().pollOnce()).toBe(1);

    // The request went out through the safe transport with the decrypted header.
    expect(target.captured).toHaveLength(1);
    expect(target.captured[0]!.headers.authorization).toBe(SECRET);
    expect(target.pinned).toHaveLength(1);

    const [check] = checksOf(monitor.id);
    expect(check).toMatchObject({ outcome: 'SUCCESS', statusCode: 200, source: 'SCHEDULED' });
    expect(check!.latencyMs).toEqual(expect.any(Number));
    expect(check!.attemptId).toEqual(expect.any(String));

    const after = await service.get(owner, monitor.id);
    expect(after).toMatchObject({
      currentStatus: 'HEALTHY',
      lastCheckedAt: now().toISOString(),
      statusChangedAt: now().toISOString(),
      nextCheckAt: '2026-11-18T10:01:00.000Z',
    });
    expect(row(monitor.id)).toMatchObject({ leaseUntil: null, leaseToken: null });

    const history = await service.listChecks(owner, monitor.id, { limit: 25 });
    expect(history.items).toEqual([
      expect.objectContaining({ outcome: 'SUCCESS', statusCode: 200, source: 'SCHEDULED' }),
    ]);
    // Nothing about the request (header values, connection details) is in the history.
    expect(JSON.stringify(history)).not.toContain(SECRET);
    expect(JSON.stringify(history)).not.toContain('93.184');
  });

  it('does not check again before the next scheduled time, and does once it is due', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200);
    target.reply('/health', 'GET', 200);
    const w = worker();
    await w.pollOnce();
    advance(30_000);
    expect(await w.pollOnce()).toBe(0);
    advance(30_000);
    expect(await w.pollOnce()).toBe(1);
    expect(checksOf(monitor.id)).toHaveLength(2);
    expect(row(monitor.id).nextCheckAt.toISOString()).toBe('2026-11-18T10:02:00.000Z');
  });

  it('skips intervals missed while no worker was running', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200);
    advance(7 * 60_000 + 30_000); // Worker down for 7.5 minutes.
    await worker().pollOnce();
    expect(checksOf(monitor.id)).toHaveLength(1);
    expect(row(monitor.id).nextCheckAt.toISOString()).toBe('2026-11-18T10:08:00.000Z');
  });

  it('never checks paused monitors', async () => {
    const monitor = await create();
    await service.pause(owner, monitor.id);
    advance(10 * 60_000);
    expect(await worker().pollOnce()).toBe(0);
    expect(target.captured).toHaveLength(0);
  });

  it('walks HEALTHY → DEGRADED → DOWN → DEGRADED → HEALTHY with the default thresholds', async () => {
    const monitor = await create();
    const w = worker();
    const statuses: string[] = [];
    for (const status of [200, 503, 500, 200, 200]) {
      target.reply('/health', 'GET', status);
      await w.pollOnce();
      statuses.push(row(monitor.id).currentStatus);
      advance(60_000);
    }
    expect(statuses).toEqual(['HEALTHY', 'DEGRADED', 'DOWN', 'DEGRADED', 'HEALTHY']);
    const failures = checksOf(monitor.id).filter((c) => c.outcome === 'FAILURE');
    expect(failures.map((c) => [c.statusCode, c.failureReason])).toEqual([
      [503, 'UNEXPECTED_STATUS'],
      [500, 'UNEXPECTED_STATUS'],
    ]);
  });

  it('records a timeout with NULL status and NULL latency', async () => {
    const monitor = await create({ timeoutMs: 1000, latencyThresholdMs: 500 });
    target.reply('/health', 'GET', 200, 'late', {}, { delayMs: 1500 });
    await worker().pollOnce();
    expect(checksOf(monitor.id)[0]).toMatchObject({
      outcome: 'FAILURE',
      failureReason: 'TIMEOUT',
      statusCode: null,
      latencyMs: null,
    });
    expect(row(monitor.id).currentStatus).toBe('DEGRADED');
  });
});

describe('manual checks (Check Now)', () => {
  it('goes through the same queue: the API queues, the worker runs it, source MANUAL', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200);
    target.reply('/health', 'GET', 200);
    const w = worker();
    await w.pollOnce(); // Scheduled check at 10:00, next at 10:01.
    advance(10_000);

    const queued = await service.requestCheck(owner, monitor.id);
    expect(queued.status).toBe('QUEUED');
    // Queuing sent nothing.
    expect(target.captured).toHaveLength(1);
    expect((await service.get(owner, monitor.id)).manualCheckQueuedAt).toBe(queued.queuedAt);

    expect(await w.pollOnce()).toBe(1);
    expect(target.captured).toHaveLength(2);
    const latest = (await service.listChecks(owner, monitor.id, { limit: 1 })).items[0]!;
    expect(latest).toMatchObject({ source: 'MANUAL', outcome: 'SUCCESS' });

    const after = await service.get(owner, monitor.id);
    expect(after.manualCheckQueuedAt).toBeNull();
    expect(after.lastManualCheckAt).toBe(now().toISOString());
    // The cadence is unchanged by the manual check.
    expect(after.nextCheckAt).toBe('2026-11-18T10:01:00.000Z');

    // Cooldown applies after the manual check completed.
    await expect(service.requestCheck(owner, monitor.id)).rejects.toMatchObject({
      code: 'CHECK_COOLDOWN',
    });
    const manual = await service.listChecks(owner, monitor.id, { limit: 25, source: 'MANUAL' });
    expect(manual.items).toHaveLength(1);
  });

  it('is claimed before due scheduled checks when capacity is short', async () => {
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B' });
    const c = await create({ name: 'C' });
    for (const m of [a, b, c]) Object.assign(row(m.id), { nextCheckAt: new Date(clock + 60_000) });
    Object.assign(row(a.id), { nextCheckAt: new Date(clock - 5000) });
    Object.assign(row(b.id), { nextCheckAt: new Date(clock - 5000) });
    await service.requestCheck(owner, c.id);
    target.reply('/health', 'GET', 200);

    await worker({ settings: { concurrency: 1 } }).pollOnce();
    expect(checksOf(c.id)).toHaveLength(1);
    expect(checksOf(c.id)[0]!.source).toBe('MANUAL');
    expect(checksOf(a.id)).toHaveLength(0);
    expect(checksOf(b.id)).toHaveLength(0);
  });
});

describe('SSRF and configuration refusals are recorded but health-neutral', () => {
  it('a hostname resolving to a private address is BLOCKED_DESTINATION and never DOWN', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200);
    const w = worker();
    await w.pollOnce();
    expect(row(monitor.id).currentStatus).toBe('HEALTHY');

    target.setDnsAnswers([{ address: '10.0.0.5', family: 4 }]);
    for (let i = 0; i < 3; i++) {
      advance(60_000);
      await w.pollOnce();
    }
    const blocked = checksOf(monitor.id).filter((c) => c.failureReason === 'BLOCKED_DESTINATION');
    expect(blocked).toHaveLength(3);
    expect(blocked.every((c) => c.statusCode === null && c.latencyMs === null)).toBe(true);
    expect(row(monitor.id)).toMatchObject({ currentStatus: 'HEALTHY', consecutiveFailures: 0 });
    // Nothing was ever sent to the private address.
    expect(target.captured).toHaveLength(1);
    expect(target.pinned).toHaveLength(1);
  });

  it('a mutating method without persisted consent is CONFIGURATION_ERROR and sends nothing', async () => {
    const monitor = await create({
      method: 'POST',
      requestBody: '{"a":1}',
      allowMutatingRequests: true,
    });
    row(monitor.id).allowMutatingRequests = false;
    await worker().pollOnce();
    expect(checksOf(monitor.id)[0]).toMatchObject({
      outcome: 'FAILURE',
      failureReason: 'CONFIGURATION_ERROR',
      statusCode: null,
      latencyMs: null,
    });
    expect(checksOf(monitor.id)[0]!.errorMessage).toMatch(/explicitly permitted/);
    expect(row(monitor.id).currentStatus).toBe('UNKNOWN');
    expect(target.captured).toHaveLength(0);
  });

  it('a stored header that cannot be decrypted is CONFIGURATION_ERROR, without leaking anything', async () => {
    const monitor = await create({ headers: [{ name: 'X-Api-Key', value: SECRET }] });
    repo.headers[0]!.valueAuthTag = Buffer.alloc(16).toString('base64');
    await worker().pollOnce();
    const [check] = checksOf(monitor.id);
    expect(check!.failureReason).toBe('CONFIGURATION_ERROR');
    expect(check!.errorMessage).not.toContain(SECRET);
    expect(target.captured).toHaveLength(0);
  });

  it('with outbound requests disabled nothing is recorded and the lease is released', async () => {
    const monitor = await create();
    const disabled = createMonitorExecutor({ transport: OUTBOUND_DISABLED, secretBox, now });
    await worker({ executor: disabled }).pollOnce();
    expect(checksOf(monitor.id)).toHaveLength(0);
    expect(row(monitor.id)).toMatchObject({
      leaseToken: null,
      leaseUntil: null,
      currentStatus: 'UNKNOWN',
    });
    expect(store.calls.release).toBe(1);
  });
});

describe('leases and concurrency', () => {
  it('claims at most the free capacity per poll', async () => {
    for (let i = 0; i < 5; i++) await create({ name: `M${i}` });
    for (let i = 0; i < 5; i++) target.reply('/health', 'GET', 200);
    const w = worker({ settings: { concurrency: 2 } });
    expect(await w.pollOnce()).toBe(2);
    expect(await w.pollOnce()).toBe(2);
    expect(await w.pollOnce()).toBe(1);
    expect(repo.checks).toHaveLength(5);
  });

  it('a live lease prevents a second claim; an expired one can be re-claimed', async () => {
    await create();
    const [first] = await store.claim(10, 90);
    expect(first).toBeDefined();
    expect(await store.claim(10, 90)).toHaveLength(0);
    advance(89_000);
    expect(await store.claim(10, 90)).toHaveLength(0);
    advance(2000);
    const [second] = await store.claim(10, 90);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
  });

  it('a stale worker (crashed or slow past its lease) never overwrites the new holder', async () => {
    const monitor = await create();
    const [stale] = await store.claim(10, 90);
    advance(91_000); // The first worker hung; its lease expired.
    const [fresh] = await store.claim(10, 90);

    const success: CheckExecution = {
      checkedAt: now(),
      result: { outcome: 'SUCCESS', statusCode: 200, latencyMs: 50, failureReason: null },
      errorMessage: null,
      response: null,
    };
    const failure: CheckExecution = {
      checkedAt: now(),
      result: { outcome: 'FAILURE', statusCode: null, latencyMs: null, failureReason: 'TIMEOUT' },
      errorMessage: 'timeout',
      response: null,
    };
    expect(await store.complete(fresh!, success)).toMatchObject({
      recorded: true,
      status: 'HEALTHY',
    });
    expect(await store.complete(stale!, failure)).toEqual({
      recorded: false,
      reason: 'LEASE_LOST',
    });
    expect(await store.release(stale!)).toBe(false);
    expect(checksOf(monitor.id)).toHaveLength(1);
    expect(row(monitor.id).currentStatus).toBe('HEALTHY');
  });

  it('records an attempt at most once (duplicate completion is a no-op)', async () => {
    const monitor = await create();
    const [claim] = await store.claim(10, 90);
    const execution: CheckExecution = {
      checkedAt: now(),
      result: { outcome: 'SUCCESS', statusCode: 200, latencyMs: 50, failureReason: null },
      errorMessage: null,
      response: null,
    };
    await store.complete(claim!, execution);
    // Simulate a retried completion whose first attempt's acknowledgement was lost.
    row(monitor.id).leaseToken = claim!.leaseToken;
    expect(await store.complete(claim!, execution)).toEqual({
      recorded: false,
      reason: 'DUPLICATE_ATTEMPT',
    });
    expect(checksOf(monitor.id)).toHaveLength(1);
  });

  it('pause during a check: the check is recorded, health is not overwritten, no overlap', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200);
    const w = worker();
    await w.pollOnce();
    advance(60_000);

    target.reply('/health', 'GET', 503, '', {}, { delayMs: 300 });
    const running = w.pollOnce();
    await vi.waitFor(() => expect(target.captured).toHaveLength(2));
    await service.pause(owner, monitor.id);
    await service.resume(owner, monitor.id);
    // Lease still held, so even the resumed (due) monitor is not claimed twice.
    expect(await store.claim(10, 90)).toHaveLength(0);
    await running;

    expect(checksOf(monitor.id).map((c) => c.statusCode)).toEqual([200, 503]);
    // The resume happened mid-check: the paused-at-completion rule didn't apply, so the 503 counts.
    expect(row(monitor.id).currentStatus).toBe('DEGRADED');
  });

  it('pause that is still in effect at completion leaves health untouched', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 503, '', {}, { delayMs: 300 });
    const running = worker().pollOnce();
    await vi.waitFor(() => expect(target.captured).toHaveLength(1));
    await service.pause(owner, monitor.id);
    await running;
    expect(checksOf(monitor.id)).toHaveLength(1);
    expect(row(monitor.id)).toMatchObject({
      currentStatus: 'UNKNOWN',
      leaseToken: null,
      enabled: false,
    });
  });

  it('delete during a check: the result is discarded', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200, '', {}, { delayMs: 300 });
    const running = worker().pollOnce();
    await vi.waitFor(() => expect(target.captured).toHaveLength(1));
    await service.remove(owner, monitor.id);
    await running;
    expect(repo.checks).toHaveLength(0);
    expect(repo.monitors).toHaveLength(0);
  });
});

describe('worker operations', () => {
  it('releases the lease (and advances the schedule) when completion fails unexpectedly', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200);
    store.failNext('complete');
    await worker().pollOnce();
    expect(checksOf(monitor.id)).toHaveLength(0);
    expect(row(monitor.id)).toMatchObject({ leaseToken: null, currentStatus: 'UNKNOWN' });
    expect(row(monitor.id).nextCheckAt.toISOString()).toBe('2026-11-18T10:01:00.000Z');
  });

  it('survives a database interruption while claiming and resumes polling', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200);
    store.failNext('claim');
    const w = worker();
    w.start();
    await vi.waitFor(() => expect(checksOf(monitor.id)).toHaveLength(1), { timeout: 3000 });
    expect(store.calls.claim).toBeGreaterThanOrEqual(2);
    expect(await w.stop(1000)).toEqual({ drained: true, abandoned: 0 });
  });

  it('drains in-flight checks on stop and claims nothing new', async () => {
    const monitor = await create();
    target.reply('/health', 'GET', 200, '', {}, { delayMs: 300 });
    const w = worker();
    w.start();
    await vi.waitFor(() => expect(target.captured).toHaveLength(1));
    expect(w.inFlight).toBe(1);
    const claimsBefore = store.calls.claim;
    expect(await w.stop(5000)).toEqual({ drained: true, abandoned: 0 });
    expect(checksOf(monitor.id)).toHaveLength(1);
    expect(store.calls.claim).toBe(claimsBefore);
  });

  it('reports abandoned checks when the grace period runs out', async () => {
    await create();
    target.reply('/health', 'GET', 200, '', {}, { delayMs: 800 });
    const w = worker();
    w.start();
    await vi.waitFor(() => expect(target.captured).toHaveLength(1));
    expect(await w.stop(50)).toEqual({ drained: false, abandoned: 1 });
    // Let the request finish so the target can close cleanly.
    await vi.waitFor(() => expect(w.inFlight).toBe(0), { timeout: 3000 });
  });

  it('rejects unsafe settings, including a lease shorter than the longest request', () => {
    expect(
      validateWorkerSettings({
        concurrency: 25,
        pollIntervalMs: 1000,
        leaseSeconds: 90,
        maxBackoffMs: 30_000,
      }),
    ).toEqual([]);
    expect(
      validateWorkerSettings({
        concurrency: 0,
        pollIntervalMs: 1000,
        leaseSeconds: 30,
        maxBackoffMs: 30_000,
      }),
    ).toEqual([expect.stringMatching(/concurrency/), expect.stringMatching(/leaseSeconds/)]);
    expect(() =>
      createMonitoringWorker({
        store,
        executor: executor(),
        logger: silent,
        settings: { leaseSeconds: 10 },
      }),
    ).toThrow(RangeError);
  });
});

describe('safeError', () => {
  it('logs the driver cause, never the SQL text or parameters of a wrapped query error', async () => {
    const { safeError } = await import('./worker-engine.js');
    const driver = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const wrapped = new Error('Failed query: update "monitors" set ... params: secret-ish,42', {
      cause: driver,
    });
    expect(safeError(wrapped)).toEqual({
      name: 'Error',
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 127.0.0.1:5432',
    });
    expect(safeError(new Error('Failed query: select 1 params: x'))).toEqual({
      name: 'Error',
      message: 'Database query failed',
    });
    expect(safeError('weird')).toEqual({ message: 'Unknown error' });
  });
});
