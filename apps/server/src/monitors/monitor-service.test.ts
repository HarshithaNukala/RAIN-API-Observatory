import { randomBytes, randomUUID } from 'node:crypto';
import {
  CreateMonitorSchema,
  HEADER_LIMITS,
  MonitorHeaderUpdateSchema,
  type CreateMonitorInput,
  type MonitorHeaderUpdateInput,
} from '@rain/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox, type SecretBox } from '../crypto/secret-box.js';
import type { ProfileStore } from '../db/profiles.js';
import { AppError } from '../errors.js';
import {
  createInMemoryMonitorRepository,
  type InMemoryMonitorRepository,
} from '../test-support/in-memory-monitor-repository.js';
import { createMonitorService, type MonitorService } from './monitor-service.js';

// Service logic against an in-memory repository and the real AES-256-GCM secret box.
// SQL, constraints and real transactions are covered by tests/integration/monitors.test.ts.

const SECRET = 'Bearer sk_live_do-not-leak-0123456789';
const BODY = '{"probe":"rain","token":"body-secret-42"}';
const KEY_1 = randomBytes(32);
const KEY_2 = randomBytes(32);

const profiles: ProfileStore = {
  ensure: async (id) => ({
    id,
    displayName: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }),
};

const boxV1 = () => createSecretBox({ currentVersion: 1, keys: new Map([[1, KEY_1]]) });
const boxV2 = () =>
  createSecretBox({
    currentVersion: 2,
    keys: new Map([
      [1, KEY_1],
      [2, KEY_2],
    ]),
  });

let repo: InMemoryMonitorRepository;
const service = (secretBox: SecretBox = boxV1(), maxMonitorsPerUser = 25): MonitorService =>
  createMonitorService({ repository: repo, profiles, secretBox, maxMonitorsPerUser });

const input = (overrides: Partial<CreateMonitorInput> = {}) =>
  CreateMonitorSchema.parse({
    name: 'Payments',
    url: 'https://api.example.com/health',
    ...overrides,
  });
const headerUpdate = (update: MonitorHeaderUpdateInput) => MonitorHeaderUpdateSchema.parse(update);

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ status, code });
  return err as AppError;
}

const owner = randomUUID();
const stranger = randomUUID();

beforeEach(() => {
  repo = createInMemoryMonitorRepository();
});

describe('create', () => {
  it('stores the body and header values only as ciphertext and never returns header values', async () => {
    const monitor = await service().create(
      owner,
      input({
        method: 'POST',
        requestBody: BODY,
        headers: [{ name: 'Authorization', value: SECRET }],
      }),
    );

    expect(monitor.headers).toEqual([
      { name: 'Authorization', configured: true, updatedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(monitor)).not.toContain(SECRET);
    expect(monitor.requestBody).toBe(BODY);

    const stored = JSON.stringify([repo.monitors, repo.headers]);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('body-secret-42');
    expect(repo.monitors[0]?.requestBodyKeyVersion).toBe(1);
  });

  it('enforces the per-user quota and counts only the caller', async () => {
    const svc = service(boxV1(), 2);
    await svc.create(owner, input());
    await svc.create(owner, input());
    await svc.create(stranger, input());
    await expectAppError(svc.create(owner, input()), 409, 'MONITOR_LIMIT_REACHED');
    expect(repo.monitors.filter((m) => m.ownerId === owner)).toHaveLength(2);
  });
});

describe('ownership', () => {
  it("answers every operation on another user's monitor with MONITOR_NOT_FOUND", async () => {
    const svc = service();
    const { id } = await svc.create(owner, input());
    const attempts = [
      svc.get(stranger, id),
      svc.update(stranger, id, { name: 'Hijacked' }),
      svc.updateHeaders(stranger, id, headerUpdate({ upsert: [{ name: 'X-Key', value: 'v' }] })),
      svc.pause(stranger, id),
      svc.resume(stranger, id),
      svc.remove(stranger, id),
    ];
    for (const attempt of attempts) await expectAppError(attempt, 404, 'MONITOR_NOT_FOUND');
    expect(repo.monitors[0]).toMatchObject({ name: 'Payments', enabled: true });
    expect(repo.headers).toHaveLength(0);
  });
});

describe('update', () => {
  it('keeps the body and credentials byte-for-byte when ordinary settings change', async () => {
    const svc = service();
    const { id } = await svc.create(
      owner,
      input({ method: 'POST', requestBody: BODY, headers: [{ name: 'X-Key', value: SECRET }] }),
    );
    const before = { monitor: { ...repo.monitors[0] }, headers: structuredClone(repo.headers) };

    const updated = await svc.update(owner, id, { name: 'Renamed', timeoutMs: 5000 });

    expect(updated).toMatchObject({ name: 'Renamed', timeoutMs: 5000, requestBody: BODY });
    expect(repo.monitors[0]).toMatchObject({
      requestBodyCiphertext: before.monitor.requestBodyCiphertext,
      requestBodyIv: before.monitor.requestBodyIv,
      requestBodyAuthTag: before.monitor.requestBodyAuthTag,
    });
    expect(repo.headers).toEqual(before.headers);
  });

  it('re-encrypts a kept body sealed with a retired key using the current key', async () => {
    const { id } = await service(boxV1()).create(
      owner,
      input({ method: 'POST', requestBody: BODY }),
    );
    const oldCiphertext = repo.monitors[0]?.requestBodyCiphertext;

    const rotated = service(boxV2());
    const updated = await rotated.update(owner, id, { name: 'After rotation' });

    expect(updated.requestBody).toBe(BODY);
    expect(repo.monitors[0]?.requestBodyKeyVersion).toBe(2);
    expect(repo.monitors[0]?.requestBodyCiphertext).not.toBe(oldCiphertext);
    // Readable with only the new key, so the retired key is no longer needed for this row.
    const newKeyOnly = createSecretBox({ currentVersion: 2, keys: new Map([[2, KEY_2]]) });
    expect((await service(newKeyOnly).get(owner, id)).requestBody).toBe(BODY);
  });

  it('leaves a body already on the current key untouched', async () => {
    const svc = service();
    const { id } = await svc.create(owner, input({ method: 'POST', requestBody: BODY }));
    const ciphertext = repo.monitors[0]?.requestBodyCiphertext;
    await svc.update(owner, id, { name: 'Renamed' });
    expect(repo.monitors[0]?.requestBodyCiphertext).toBe(ciphertext);
  });

  it('validates the merged configuration and changes nothing when it is invalid', async () => {
    const svc = service();
    const { id } = await svc.create(owner, input({ method: 'POST', requestBody: BODY }));
    const err = await expectAppError(
      svc.update(owner, id, { method: 'GET' }),
      400,
      'VALIDATION_ERROR',
    );
    expect(err.details).toEqual([expect.objectContaining({ path: 'requestBody' })]);
    expect(repo.monitors[0]?.method).toBe('POST');
  });
});

describe('header size limit', () => {
  const big = (i: number) => ({
    name: `X-H-${i}`,
    value: 'v'.repeat(HEADER_LIMITS.maxValueLength),
  });
  // 7 x (5 + 4096) = 28,707 bytes: valid on its own, with room for less than one more.
  const sevenBig = () => Array.from({ length: 7 }, (_, i) => big(i));

  it('counts headers already stored, not just the ones in the request', async () => {
    const svc = service();
    const { id } = await svc.create(owner, input({ headers: sevenBig() }));
    const before = structuredClone(repo.headers);

    const err = await expectAppError(
      svc.updateHeaders(owner, id, headerUpdate({ upsert: [big(7)] })),
      400,
      'VALIDATION_ERROR',
    );
    expect(err.details).toEqual([
      expect.objectContaining({ path: 'upsert', message: expect.stringMatching(/too large/) }),
    ]);
    expect(repo.headers).toEqual(before);
  });

  it('counts a replaced header at its new size', async () => {
    const svc = service();
    const { id } = await svc.create(owner, input({ headers: sevenBig() }));
    await svc.updateHeaders(
      owner,
      id,
      headerUpdate({ upsert: [{ name: 'X-H-0', value: 'small' }] }),
    );
    const updated = await svc.updateHeaders(owner, id, headerUpdate({ upsert: [big(7)] }));
    expect(updated.headers).toHaveLength(8);
  });

  it('frees the space of headers removed in the same request', async () => {
    const svc = service();
    const { id } = await svc.create(owner, input({ headers: sevenBig() }));
    const updated = await svc.updateHeaders(
      owner,
      id,
      headerUpdate({ remove: ['x-h-0'], upsert: [big(7)] }),
    );
    expect(updated.headers.map((h) => h.name)).not.toContain('X-H-0');
    expect(updated.headers).toHaveLength(7);
  });

  it('measures stored values in UTF-8 bytes without decrypting them', async () => {
    const svc = service();
    // 'é' is two bytes in UTF-8: 7 x (5 + 4096 x 2) does not fit.
    const accented = Array.from({ length: 4 }, (_, i) => ({
      name: `X-H-${i}`,
      value: 'é'.repeat(HEADER_LIMITS.maxValueLength),
    }));
    const { id } = await svc.create(owner, input({ headers: accented.slice(0, 3) }));
    await expectAppError(
      svc.updateHeaders(owner, id, headerUpdate({ upsert: [accented[3]!, big(9)] })),
      400,
      'VALIDATION_ERROR',
    );
  });
});

describe('list', () => {
  it('reads the page, filtered total and quota in one read-only snapshot', async () => {
    const svc = service();
    await svc.create(owner, input({ name: 'Alpha' }));
    await svc.create(owner, input({ name: 'Beta' }));
    repo.transactionConfigs.length = 0;

    const result = await svc.list(owner, { search: 'alp', state: 'all', limit: 25 });

    expect(result).toMatchObject({ total: 1, quota: { used: 2, limit: 25 }, nextCursor: null });
    expect(result.items.map((m) => m.name)).toEqual(['Alpha']);
    expect(repo.transactionConfigs).toEqual([
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ]);
  });

  it('pages through every monitor exactly once', async () => {
    const svc = service();
    for (let i = 0; i < 5; i++) await svc.create(owner, input({ name: `M${i}` }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.list(owner, { state: 'all', limit: 2, cursor });
      seen.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });
});

describe('pause and resume', () => {
  it('reports no upcoming check while paused and reschedules on resume', async () => {
    const svc = service();
    const { id } = await svc.create(owner, input());

    const paused = await svc.pause(owner, id);
    expect(paused).toMatchObject({ enabled: false, nextCheckAt: null });
    const listed = await svc.list(owner, { state: 'paused', limit: 25 });
    expect(listed.items[0]?.nextCheckAt).toBeNull();

    const resumed = await svc.resume(owner, id);
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextCheckAt).toEqual(expect.any(String));
  });
});
