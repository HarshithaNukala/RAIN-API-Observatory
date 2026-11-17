import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  MonitorListResponseSchema,
  MonitorResponseSchema,
  dataEnvelope,
  type Monitor,
  type MonitorList,
} from '@rain/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monitorHeaders, monitors } from '../../apps/server/src/db/schema.js';
import { createHarness, sqlState, type Harness, type TestUser } from './harness.js';

const SECRET = 'Bearer live-secret-token-9f8e7d';
const BODY_SECRET = '{"clientSecret":"body-secret-1a2b3c"}';

let h: Harness;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  h = await createHarness();
  alice = await h.createUser();
  bob = await h.createUser();
});

afterAll(async () => {
  await h.close();
});

const basic = (overrides: object = {}) => ({
  name: 'Payments API',
  url: 'https://api.example.com/health',
  ...overrides,
});

async function createMonitor(user: TestUser, overrides: object = {}): Promise<Monitor> {
  const res = await user.post('/api/v1/monitors', basic(overrides)).expect(201);
  return dataEnvelope(MonitorResponseSchema).parse(res.body).data;
}

const headerRows = (monitorId: string) =>
  h.db
    .select()
    .from(monitorHeaders)
    .where(eq(monitorHeaders.monitorId, monitorId))
    .orderBy(sql`lower(${monitorHeaders.headerName})`);

const monitorRow = async (monitorId: string) =>
  (await h.db.select().from(monitors).where(eq(monitors.id, monitorId)))[0];

function decryptHeader(row: Awaited<ReturnType<typeof headerRows>>[number]): string {
  return h.secretBox.decrypt(
    {
      ciphertext: row.valueCiphertext,
      iv: row.valueIv,
      authTag: row.valueAuthTag,
      keyVersion: row.encryptionKeyVersion,
    },
    `monitor-header:${row.monitorId}:${row.headerName.toLowerCase()}`,
  );
}

const errorOf = (body: unknown) => ApiErrorSchema.parse(body).error;
const detailsOf = (body: unknown) =>
  (errorOf(body).details as Array<{ path: string; message: string }>).map(
    (d) => `${d.path}: ${d.message}`,
  );

describe('create', () => {
  it('creates a monitor with defaults, owned by the caller, and no invented health data', async () => {
    const before = Date.now();
    const res = await alice.post('/api/v1/monitors', basic()).expect(201);
    const monitor = dataEnvelope(MonitorResponseSchema).parse(res.body).data;

    expect(res.headers.location).toBe(`/api/v1/monitors/${monitor.id}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(monitor).toMatchObject({
      name: 'Payments API',
      description: null,
      url: 'https://api.example.com/health',
      method: 'GET',
      expectedStatusCode: 200,
      timeoutMs: 10_000,
      latencyThresholdMs: 2000,
      checkIntervalSeconds: 300,
      enabled: true,
      currentStatus: 'UNKNOWN',
      lastCheckedAt: null,
      requestBody: null,
      bodyContentType: null,
      headers: [],
    });
    expect(Date.parse(monitor.nextCheckAt!)).toBeGreaterThanOrEqual(before - 1000);

    const row = await monitorRow(monitor.id);
    expect(row).toMatchObject({
      ownerId: alice.id,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      leaseUntil: null,
    });
  });

  it('ignores any owner the client tries to supply', async () => {
    const res = await alice.post('/api/v1/monitors', basic({ ownerId: bob.id })).expect(400);
    expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
  });

  it('never returns header values or echoes them anywhere in the response', async () => {
    const res = await alice
      .post(
        '/api/v1/monitors',
        basic({
          method: 'POST',
          requestBody: BODY_SECRET,
          headers: [
            { name: 'Authorization', value: SECRET },
            { name: 'X-Api-Key', value: 'key-abc-123' },
          ],
        }),
      )
      .expect(201);

    expect(res.text).not.toContain('live-secret-token');
    expect(res.text).not.toContain('key-abc-123');
    const monitor = dataEnvelope(MonitorResponseSchema).parse(res.body).data;
    expect(monitor.headers.map((x) => ({ name: x.name, configured: x.configured }))).toEqual([
      { name: 'Authorization', configured: true },
      { name: 'X-Api-Key', configured: true },
    ]);
    for (const header of res.body.data.headers as object[]) {
      expect(Object.keys(header).sort()).toEqual(['configured', 'name', 'updatedAt']);
    }
    // The body is returned to its owner for editing, and defaults to JSON.
    expect(monitor.requestBody).toBe(BODY_SECRET);
    expect(monitor.bodyContentType).toBe('application/json');
  });

  it('stores header values and the request body only as AES-256-GCM ciphertext', async () => {
    const monitor = await createMonitor(alice, {
      method: 'POST',
      requestBody: BODY_SECRET,
      headers: [
        { name: 'Authorization', value: SECRET },
        { name: 'X-Api-Key', value: SECRET },
      ],
    });

    const rows = await headerRows(monitor.id);
    expect(rows).toHaveLength(2);
    const dump = JSON.stringify([rows, await monitorRow(monitor.id)]);
    for (const plaintext of [SECRET, 'live-secret-token', BODY_SECRET, 'body-secret-1a2b3c']) {
      expect(dump).not.toContain(plaintext);
      expect(dump).not.toContain(Buffer.from(plaintext).toString('base64'));
    }
    for (const row of rows) {
      expect(Buffer.from(row.valueIv, 'base64')).toHaveLength(12);
      expect(Buffer.from(row.valueAuthTag, 'base64')).toHaveLength(16);
      expect(row.encryptionKeyVersion).toBe(1);
      expect(decryptHeader(row)).toBe(SECRET);
    }
    // Same plaintext, different IV and ciphertext for each header.
    expect(rows[0]!.valueIv).not.toBe(rows[1]!.valueIv);
    expect(rows[0]!.valueCiphertext).not.toBe(rows[1]!.valueCiphertext);

    const row = (await monitorRow(monitor.id))!;
    expect(
      h.secretBox.decrypt(
        {
          ciphertext: row.requestBodyCiphertext!,
          iv: row.requestBodyIv!,
          authTag: row.requestBodyAuthTag!,
          keyVersion: row.requestBodyKeyVersion!,
        },
        `monitor-body:${monitor.id}`,
      ),
    ).toBe(BODY_SECRET);
  });

  it('never writes secrets, bodies or tokens to the logs', async () => {
    h.logLines.length = 0;
    const monitor = await createMonitor(alice, {
      url: 'https://api.example.com/v1/ping?tenant=acme-internal-id',
      method: 'POST',
      requestBody: BODY_SECRET,
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    await alice
      .patch(`/api/v1/monitors/${monitor.id}/headers`, {
        upsert: [{ name: 'Authorization', value: 'Bearer rotated-secret-xyz' }],
      })
      .expect(200);
    await alice.post('/api/v1/monitors', basic({ url: 'http://10.0.0.1/?token=leaky-token' }));

    const logs = h.logLines.join('');
    expect(h.logLines.length).toBeGreaterThan(0);
    for (const secret of [
      'live-secret-token',
      'rotated-secret-xyz',
      'body-secret-1a2b3c',
      'leaky-token',
      'acme-internal-id',
      'eyJ', // any JWT, i.e. the caller's bearer token
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it.each([
    ['a private IP literal', { url: 'http://192.168.1.10/health' }, /url: Private/],
    ['the cloud metadata address', { url: 'http://169.254.169.254/' }, /url: Private/],
    ['localhost', { url: 'http://localhost:8080/' }, /url: Local and internal/],
    ['an obfuscated loopback', { url: 'http://0x7f000001/' }, /url: Private/],
    [
      'embedded credentials',
      { url: 'https://user:pw@api.example.com/' },
      /url: Remove the username/,
    ],
    [
      'a credential in the query string',
      { url: 'https://api.example.com/?api_key=abc' },
      /url: Don't put credentials/,
    ],
    ['a non-HTTP scheme', { url: 'ftp://files.example.com/' }, /url: Only http/],
    ['the DELETE method', { method: 'DELETE' }, /method:/],
    [
      'an interval below one minute',
      { checkIntervalSeconds: 30 },
      /checkIntervalSeconds: .*at least 60/,
    ],
    ['a timeout above 30 s', { timeoutMs: 60_000 }, /timeoutMs: .*at most 30000/],
    ['an out-of-range status code', { expectedStatusCode: 700 }, /expectedStatusCode:/],
    ['a body on a GET monitor', { requestBody: '{}' }, /requestBody: GET/],
    [
      'a hop-by-hop header',
      { headers: [{ name: 'Host', value: 'evil.example' }] },
      /headers\.0\.name/,
    ],
    [
      'a header-injection attempt',
      { headers: [{ name: 'X-A', value: 'a\r\nX-B: b' }] },
      /headers\.0\.value/,
    ],
    [
      'duplicate headers differing only in case',
      {
        headers: [
          { name: 'X-Key', value: '1' },
          { name: 'x-key', value: '2' },
        ],
      },
      /headers\.1\.name: Duplicate/,
    ],
    [
      'more than 20 headers',
      { headers: Array.from({ length: 21 }, (_, i) => ({ name: `X-H${i}`, value: 'v' })) },
      /at most 20 headers/,
    ],
    [
      'an oversized body',
      { method: 'POST', requestBody: 'x'.repeat(64 * 1024 + 1) },
      /requestBody: .*64 KB/,
    ],
  ])('rejects %s with 400 and creates nothing', async (_label, override, expected) => {
    const carol = await h.createUser();
    const res = await carol.post('/api/v1/monitors', basic(override)).expect(400);
    expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
    expect(detailsOf(res.body).join('\n')).toMatch(expected);
    const list = await carol.get('/api/v1/monitors').expect(200);
    expect(list.body.data.total).toBe(0);
  });

  it('accepts the largest allowed body and header set in one request', async () => {
    const carol = await h.createUser();
    await carol
      .post(
        '/api/v1/monitors',
        basic({
          method: 'PUT',
          requestBody: 'x'.repeat(64 * 1024),
          headers: Array.from({ length: 20 }, (_, i) => ({
            name: `X-H${i}`,
            value: 'v'.repeat(1500),
          })),
        }),
      )
      .expect(201);
  });

  it('rolls back the monitor row when a later step of the transaction fails', async () => {
    let encryptions = 0;
    const failing = await createHarness({
      wrapSecretBox: (box) => ({
        ...box,
        encrypt(plaintext, context) {
          if (++encryptions === 2) throw new Error('simulated failure while sealing header 2');
          return box.encrypt(plaintext, context);
        },
      }),
    });
    try {
      const user = await failing.createUser();
      const res = await user
        .post(
          '/api/v1/monitors',
          basic({
            headers: [
              { name: 'X-One', value: '1' },
              { name: 'X-Two', value: '2' },
            ],
          }),
        )
        .expect(500);
      expect(errorOf(res.body).code).toBe('INTERNAL_ERROR');
      expect(res.text).not.toContain('simulated failure');

      const rows = await failing.db.select().from(monitors).where(eq(monitors.ownerId, user.id));
      expect(rows).toHaveLength(0);
    } finally {
      await failing.close();
    }
  });
});

describe('ownership isolation', () => {
  let monitor: Monitor;

  beforeAll(async () => {
    monitor = await createMonitor(alice, {
      name: 'Alice private monitor',
      headers: [{ name: 'Authorization', value: SECRET }],
    });
  });

  it('lets the owner read their monitor', async () => {
    const res = await alice.get(`/api/v1/monitors/${monitor.id}`).expect(200);
    expect(dataEnvelope(MonitorResponseSchema).parse(res.body).data.name).toBe(
      'Alice private monitor',
    );
  });

  it.each([
    ['read', (u: TestUser, id: string) => u.get(`/api/v1/monitors/${id}`)],
    [
      'update',
      (u: TestUser, id: string) => u.patch(`/api/v1/monitors/${id}`, { name: 'Hijacked' }),
    ],
    [
      'change headers of',
      (u: TestUser, id: string) =>
        u.patch(`/api/v1/monitors/${id}/headers`, {
          upsert: [{ name: 'Authorization', value: 'Bearer attacker' }],
          remove: [],
        }),
    ],
    [
      'remove headers of',
      (u: TestUser, id: string) =>
        u.patch(`/api/v1/monitors/${id}/headers`, { remove: ['Authorization'] }),
    ],
    ['pause', (u: TestUser, id: string) => u.post(`/api/v1/monitors/${id}/pause`)],
    ['resume', (u: TestUser, id: string) => u.post(`/api/v1/monitors/${id}/resume`)],
    ['delete', (u: TestUser, id: string) => u.delete(`/api/v1/monitors/${id}`)],
  ])(
    "another user cannot %s it, and gets the same 404 as for a monitor that doesn't exist",
    async (_label, attempt) => {
      const foreign = await attempt(bob, monitor.id).expect(404);
      const missing = await attempt(bob, randomUUID()).expect(404);
      expect(errorOf(foreign.body)).toMatchObject({
        code: 'MONITOR_NOT_FOUND',
        message: 'Monitor not found',
      });
      const { requestId: _a, ...foreignError } = errorOf(foreign.body);
      const { requestId: _b, ...missingError } = errorOf(missing.body);
      expect(foreignError).toEqual(missingError);
    },
  );

  it('leaves the monitor completely unchanged after every cross-user attempt', async () => {
    const after = dataEnvelope(MonitorResponseSchema).parse(
      (await alice.get(`/api/v1/monitors/${monitor.id}`).expect(200)).body,
    ).data;
    expect(after).toEqual(monitor);
    const rows = await headerRows(monitor.id);
    expect(rows).toHaveLength(1);
    expect(decryptHeader(rows[0]!)).toBe(SECRET);
  });

  it("never lists another user's monitors or counts them against the quota", async () => {
    const dave = await h.createUser();
    const res = await dave.get('/api/v1/monitors').expect(200);
    const list = dataEnvelope(MonitorListResponseSchema).parse(res.body).data;
    expect(list).toMatchObject({
      items: [],
      total: 0,
      nextCursor: null,
      quota: { used: 0, limit: 25 },
    });
  });

  it('treats a malformed ID as not found', async () => {
    for (const id of ['123', 'not-a-uuid', '../me']) {
      const res = await alice.get(`/api/v1/monitors/${encodeURIComponent(id)}`).expect(404);
      expect(errorOf(res.body).code).toBe('MONITOR_NOT_FOUND');
    }
  });

  it.each([
    ['GET', '/api/v1/monitors'],
    ['POST', '/api/v1/monitors'],
    ['GET', `/api/v1/monitors/${randomUUID()}`],
    ['PATCH', `/api/v1/monitors/${randomUUID()}`],
    ['PATCH', `/api/v1/monitors/${randomUUID()}/headers`],
    ['POST', `/api/v1/monitors/${randomUUID()}/pause`],
    ['POST', `/api/v1/monitors/${randomUUID()}/resume`],
    ['DELETE', `/api/v1/monitors/${randomUUID()}`],
  ] as const)('requires authentication for %s %s', async (method, path) => {
    const call = {
      GET: h.anonymous.get,
      POST: h.anonymous.post,
      PATCH: h.anonymous.patch,
      DELETE: h.anonymous.delete,
    }[method];
    const res = await call(path).expect(401);
    expect(errorOf(res.body).code).toBe('UNAUTHENTICATED');
  });
});

describe('update', () => {
  // A fresh owner per group keeps each group well under the per-user monitor quota.
  beforeAll(async () => {
    alice = await h.createUser();
  });

  it('changes only the supplied fields', async () => {
    const monitor = await createMonitor(alice, {
      description: 'Original',
      checkIntervalSeconds: 120,
    });
    const res = await alice
      .patch(`/api/v1/monitors/${monitor.id}`, { name: 'Renamed', checkIntervalSeconds: 600 })
      .expect(200);
    const updated = dataEnvelope(MonitorResponseSchema).parse(res.body).data;
    expect(updated).toMatchObject({
      name: 'Renamed',
      checkIntervalSeconds: 600,
      description: 'Original',
      url: monitor.url,
      timeoutMs: monitor.timeoutMs,
      enabled: true,
      currentStatus: 'UNKNOWN',
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(monitor.updatedAt));
    expect(updated.createdAt).toBe(monitor.createdAt);
  });

  it('keeps every stored credential byte-for-byte when ordinary settings change', async () => {
    const monitor = await createMonitor(alice, {
      headers: [
        { name: 'Authorization', value: SECRET },
        { name: 'X-Api-Key', value: 'key-abc-123' },
      ],
    });
    const before = await headerRows(monitor.id);

    const res = await alice
      .patch(`/api/v1/monitors/${monitor.id}`, {
        name: 'New name',
        description: 'New description',
        url: 'https://api.example.com/v2/health',
        checkIntervalSeconds: 900,
        timeoutMs: 5000,
        latencyThresholdMs: 750,
        expectedStatusCode: 204,
      })
      .expect(200);

    expect(res.body.data.headers.map((x: { name: string }) => x.name)).toEqual([
      'Authorization',
      'X-Api-Key',
    ]);
    expect(await headerRows(monitor.id)).toEqual(before);
    expect(decryptHeader((await headerRows(monitor.id))[0]!)).toBe(SECRET);
  });

  it('refuses a headers field in the settings PATCH and leaves credentials intact', async () => {
    const monitor = await createMonitor(alice, {
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    const before = await headerRows(monitor.id);
    for (const headers of [[], [{ name: 'Authorization', value: 'overwritten' }]]) {
      const res = await alice
        .patch(`/api/v1/monitors/${monitor.id}`, { name: 'x', headers })
        .expect(400);
      expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
    }
    expect(await headerRows(monitor.id)).toEqual(before);
    expect((await monitorRow(monitor.id))!.name).toBe('Payments API');
  });

  it('keeps the request body when omitted, replaces it when given, removes it on null', async () => {
    const monitor = await createMonitor(alice, {
      method: 'POST',
      requestBody: BODY_SECRET,
      bodyContentType: 'application/vnd.api+json',
    });
    const stored = async () => {
      const row = (await monitorRow(monitor.id))!;
      return [row.requestBodyCiphertext, row.requestBodyIv, row.requestBodyAuthTag];
    };
    const original = await stored();

    const renamed = await alice
      .patch(`/api/v1/monitors/${monitor.id}`, { name: 'Renamed' })
      .expect(200);
    expect(renamed.body.data).toMatchObject({
      requestBody: BODY_SECRET,
      bodyContentType: 'application/vnd.api+json',
    });
    expect(await stored()).toEqual(original);

    const replaced = await alice
      .patch(`/api/v1/monitors/${monitor.id}`, { requestBody: '{"v":2}' })
      .expect(200);
    expect(replaced.body.data).toMatchObject({
      requestBody: '{"v":2}',
      bodyContentType: 'application/vnd.api+json',
    });
    expect(await stored()).not.toEqual(original);

    const cleared = await alice
      .patch(`/api/v1/monitors/${monitor.id}`, { requestBody: null })
      .expect(200);
    expect(cleared.body.data).toMatchObject({ requestBody: null, bodyContentType: null });
    expect(await stored()).toEqual([null, null, null]);
  });

  it('validates the merged configuration, not just the patch', async () => {
    const monitor = await createMonitor(alice, {
      method: 'POST',
      requestBody: '{}',
      timeoutMs: 5000,
      latencyThresholdMs: 4000,
    });
    const path = `/api/v1/monitors/${monitor.id}`;

    const toGet = await alice.patch(path, { method: 'GET' }).expect(400);
    expect(detailsOf(toGet.body)).toEqual([
      expect.stringMatching(/^requestBody: GET requests can't send a body/),
    ]);

    const shortTimeout = await alice.patch(path, { timeoutMs: 2000 }).expect(400);
    expect(detailsOf(shortTimeout.body)).toEqual([expect.stringMatching(/^latencyThresholdMs: /)]);

    // Nothing was changed by the rejected requests.
    expect(await monitorRow(monitor.id)).toMatchObject({ method: 'POST', timeoutMs: 5000 });

    // Explicitly dropping the body makes the same method change valid.
    const ok = await alice.patch(path, { method: 'GET', requestBody: null }).expect(200);
    expect(ok.body.data).toMatchObject({ method: 'GET', requestBody: null, bodyContentType: null });
  });

  it.each([
    ['an unsafe URL', { url: 'http://127.0.0.1:9000/' }],
    ['an unsupported method', { method: 'TRACE' }],
    ['an interval above one day', { checkIntervalSeconds: 100_000 }],
    ['a server-managed field', { currentStatus: 'HEALTHY' }],
    ['the enabled flag', { enabled: false }],
    ['an empty patch', {}],
  ])('rejects %s', async (_label, patch) => {
    const monitor = await createMonitor(alice);
    const res = await alice.patch(`/api/v1/monitors/${monitor.id}`, patch).expect(400);
    expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
    expect(await monitorRow(monitor.id)).toMatchObject({
      url: monitor.url,
      currentStatus: 'UNKNOWN',
      enabled: true,
    });
  });
});

describe('header management', () => {
  // A fresh owner per group keeps each group well under the per-user monitor quota.
  beforeAll(async () => {
    alice = await h.createUser();
  });

  const headersPath = (id: string) => `/api/v1/monitors/${id}/headers`;

  it('replaces a credential explicitly, re-encrypting it, without returning it', async () => {
    const monitor = await createMonitor(alice, {
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    const [before] = await headerRows(monitor.id);

    const res = await alice
      .patch(headersPath(monitor.id), {
        upsert: [{ name: 'authorization', value: 'Bearer replacement-77' }],
      })
      .expect(200);
    expect(res.text).not.toContain('replacement-77');
    expect(res.body.data.headers).toEqual([
      { name: 'authorization', configured: true, updatedAt: expect.any(String) },
    ]);

    const rows = await headerRows(monitor.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.valueCiphertext).not.toBe(before!.valueCiphertext);
    expect(rows[0]!.valueIv).not.toBe(before!.valueIv);
    expect(decryptHeader(rows[0]!)).toBe('Bearer replacement-77');
  });

  it('adds a header while leaving the ones not mentioned untouched', async () => {
    const monitor = await createMonitor(alice, {
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    const [authBefore] = await headerRows(monitor.id);

    await alice
      .patch(headersPath(monitor.id), { upsert: [{ name: 'X-Tenant', value: 'acme' }] })
      .expect(200);

    const rows = await headerRows(monitor.id);
    expect(rows.map((r) => r.headerName)).toEqual(['Authorization', 'X-Tenant']);
    expect(rows[0]).toEqual(authBefore);
    expect(decryptHeader(rows[1]!)).toBe('acme');
  });

  it('removes only the headers named in remove, matching case-insensitively', async () => {
    const monitor = await createMonitor(alice, {
      headers: [
        { name: 'Authorization', value: SECRET },
        { name: 'X-Old-Key', value: 'old' },
        { name: 'X-Keep', value: 'keep' },
      ],
    });
    const res = await alice.patch(headersPath(monitor.id), { remove: ['x-old-key'] }).expect(200);
    expect(res.body.data.headers.map((x: { name: string }) => x.name)).toEqual([
      'Authorization',
      'X-Keep',
    ]);
    const rows = await headerRows(monitor.id);
    expect(rows.map((r) => decryptHeader(r))).toEqual([SECRET, 'keep']);
  });

  it('applies upserts and removals together, and ignores removal of an absent header', async () => {
    const monitor = await createMonitor(alice, { headers: [{ name: 'X-Old-Key', value: 'old' }] });
    await alice
      .patch(headersPath(monitor.id), {
        upsert: [{ name: 'Authorization', value: 'Bearer new' }],
        remove: ['X-Old-Key', 'X-Never-Existed'],
      })
      .expect(200);
    expect((await headerRows(monitor.id)).map((r) => r.headerName)).toEqual(['Authorization']);
  });

  it('enforces the 20-header cap across existing and new headers, atomically', async () => {
    const monitor = await createMonitor(alice, {
      headers: Array.from({ length: 19 }, (_, i) => ({
        name: `X-H${String(i).padStart(2, '0')}`,
        value: 'v',
      })),
    });
    const before = await headerRows(monitor.id);

    const res = await alice
      .patch(headersPath(monitor.id), {
        upsert: [
          { name: 'X-H00', value: 'replaced' },
          { name: 'X-New-1', value: 'a' },
          { name: 'X-New-2', value: 'b' },
        ],
      })
      .expect(400);
    expect(detailsOf(res.body)[0]).toMatch(/at most 20 headers/);
    // Nothing from the rejected request was applied, not even the replacement.
    expect(await headerRows(monitor.id)).toEqual(before);

    // Removing one in the same request makes room.
    await alice
      .patch(headersPath(monitor.id), {
        upsert: [
          { name: 'X-New-1', value: 'a' },
          { name: 'X-New-2', value: 'b' },
        ],
        remove: ['X-H18'],
      })
      .expect(200);
    expect(await headerRows(monitor.id)).toHaveLength(20);
  });

  it.each([
    ['an empty update', {}],
    ['a forbidden header', { upsert: [{ name: 'Transfer-Encoding', value: 'chunked' }] }],
    ['a value with a line break', { upsert: [{ name: 'X-A', value: 'a\nb' }] }],
    ['an upsert without a value', { upsert: [{ name: 'X-A' }] }],
    [
      'the same header upserted and removed',
      { upsert: [{ name: 'X-A', value: '1' }], remove: ['x-a'] },
    ],
    ['unknown properties', { upsert: [], remove: [], replaceAll: true }],
  ])('rejects %s', async (_label, body) => {
    const monitor = await createMonitor(alice, {
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    const before = await headerRows(monitor.id);
    const res = await alice.patch(headersPath(monitor.id), body).expect(400);
    expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
    expect(await headerRows(monitor.id)).toEqual(before);
  });
});

describe('pause and resume', () => {
  // A fresh owner per group keeps each group well under the per-user monitor quota.
  beforeAll(async () => {
    alice = await h.createUser();
  });

  it('toggle enabled without touching health status, counters or check history', async () => {
    const monitor = await createMonitor(alice);
    // Simulate state a future monitoring engine would have written.
    const checkedAt = new Date('2026-11-01T10:00:00.000Z');
    await h.db
      .update(monitors)
      .set({
        currentStatus: 'DOWN',
        consecutiveFailures: 3,
        lastCheckedAt: checkedAt,
        leaseUntil: new Date(Date.now() + 60_000),
        nextCheckAt: new Date('2026-11-01T10:05:00.000Z'),
      })
      .where(eq(monitors.id, monitor.id));

    const paused = await alice.post(`/api/v1/monitors/${monitor.id}/pause`).expect(200);
    expect(paused.body.data).toMatchObject({
      enabled: false,
      currentStatus: 'DOWN',
      lastCheckedAt: checkedAt.toISOString(),
    });
    expect(await monitorRow(monitor.id)).toMatchObject({
      enabled: false,
      currentStatus: 'DOWN',
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      leaseUntil: null,
    });

    const before = Date.now();
    const resumed = await alice.post(`/api/v1/monitors/${monitor.id}/resume`).expect(200);
    const body = dataEnvelope(MonitorResponseSchema).parse(resumed.body).data;
    expect(body).toMatchObject({
      enabled: true,
      currentStatus: 'DOWN',
      lastCheckedAt: checkedAt.toISOString(),
    });
    // Rescheduled for now rather than given a made-up result.
    expect(Date.parse(body.nextCheckAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(await monitorRow(monitor.id)).toMatchObject({
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    });
  });

  it('are idempotent', async () => {
    const monitor = await createMonitor(alice);
    await alice.post(`/api/v1/monitors/${monitor.id}/pause`).expect(200);
    const again = await alice.post(`/api/v1/monitors/${monitor.id}/pause`).expect(200);
    expect(again.body.data.enabled).toBe(false);
    await alice.post(`/api/v1/monitors/${monitor.id}/resume`).expect(200);
    const resumedAgain = await alice.post(`/api/v1/monitors/${monitor.id}/resume`).expect(200);
    expect(resumedAgain.body.data).toMatchObject({
      enabled: true,
      currentStatus: 'UNKNOWN',
      lastCheckedAt: null,
    });
  });

  it('keep configuration and credentials', async () => {
    const monitor = await createMonitor(alice, {
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    const before = await headerRows(monitor.id);
    await alice.post(`/api/v1/monitors/${monitor.id}/pause`).expect(200);
    await alice.post(`/api/v1/monitors/${monitor.id}/resume`).expect(200);
    expect(await headerRows(monitor.id)).toEqual(before);
  });
});

describe('delete', () => {
  // A fresh owner per group keeps each group well under the per-user monitor quota.
  beforeAll(async () => {
    alice = await h.createUser();
  });

  it('removes the monitor and its header rows', async () => {
    const monitor = await createMonitor(alice, {
      headers: [
        { name: 'Authorization', value: SECRET },
        { name: 'X-Api-Key', value: 'k' },
      ],
    });
    expect(await headerRows(monitor.id)).toHaveLength(2);

    const res = await alice.delete(`/api/v1/monitors/${monitor.id}`).expect(204);
    expect(res.text).toBe('');

    expect(await monitorRow(monitor.id)).toBeUndefined();
    expect(await headerRows(monitor.id)).toHaveLength(0);
    await alice.get(`/api/v1/monitors/${monitor.id}`).expect(404);
    await alice.delete(`/api/v1/monitors/${monitor.id}`).expect(404);
  });

  it('cascades from the account: deleting the auth user removes monitors and headers', async () => {
    const erin = await h.createUser();
    const monitor = await createMonitor(erin, {
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    await h.db.execute(sql`delete from auth.users where id = ${erin.id}`);
    expect(await monitorRow(monitor.id)).toBeUndefined();
    expect(await headerRows(monitor.id)).toHaveLength(0);
  });
});

describe('quota', () => {
  let limited: Harness;

  beforeAll(async () => {
    limited = await createHarness({ maxMonitorsPerUser: 3 });
  });
  afterAll(async () => {
    await limited.close();
  });

  it('rejects the monitor over the limit with 409 and frees a slot on delete', async () => {
    const user = await limited.createUser();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await user.post('/api/v1/monitors', basic({ name: `M${i}` })).expect(201);
      ids.push(res.body.data.id as string);
    }
    const over = await user.post('/api/v1/monitors', basic({ name: 'One too many' })).expect(409);
    expect(errorOf(over.body)).toMatchObject({ code: 'MONITOR_LIMIT_REACHED' });
    expect(errorOf(over.body).message).toContain('3');

    const list = await user.get('/api/v1/monitors').expect(200);
    expect(list.body.data.quota).toEqual({ used: 3, limit: 3 });

    await user.delete(`/api/v1/monitors/${ids[0]}`).expect(204);
    await user.post('/api/v1/monitors', basic({ name: 'Fits now' })).expect(201);
  });

  it("is per user: one user's monitors don't consume another's quota", async () => {
    const first = await limited.createUser();
    const second = await limited.createUser();
    for (let i = 0; i < 3; i++) await first.post('/api/v1/monitors', basic()).expect(201);
    await second.post('/api/v1/monitors', basic()).expect(201);
  });

  it('holds under concurrent creation', async () => {
    const user = await limited.createUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        user.post('/api/v1/monitors', basic({ name: `Race ${i}` })),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 409, 409, 409, 409, 409]);
    const rows = await limited.db.select().from(monitors).where(eq(monitors.ownerId, user.id));
    expect(rows).toHaveLength(3);
  });
});

describe('list', () => {
  let user: TestUser;
  const listOf = async (query = ''): Promise<MonitorList> =>
    dataEnvelope(MonitorListResponseSchema).parse(
      (await user.get(`/api/v1/monitors${query}`).expect(200)).body,
    ).data;

  beforeAll(async () => {
    user = await h.createUser();
    const names = [
      'Alpha API',
      'Beta API',
      'Gamma service',
      'Delta 100% uptime',
      'Epsilon a_b',
      'Zeta axb',
      'Eta API',
    ];
    const created: Monitor[] = [];
    for (const name of names) {
      created.push(
        await createMonitor(user, {
          name,
          method: 'POST',
          requestBody: BODY_SECRET,
          headers: [{ name: 'Authorization', value: SECRET }],
        }),
      );
    }
    await user.post(`/api/v1/monitors/${created[1]!.id}/pause`).expect(200);
    await user.post(`/api/v1/monitors/${created[2]!.id}/pause`).expect(200);
    await h.db
      .update(monitors)
      .set({ currentStatus: 'DOWN' })
      .where(eq(monitors.id, created[0]!.id));
    await h.db
      .update(monitors)
      .set({ currentStatus: 'HEALTHY' })
      .where(eq(monitors.id, created[1]!.id));
    await h.db
      .update(monitors)
      .set({ currentStatus: 'HEALTHY' })
      .where(eq(monitors.id, created[3]!.id));
  });

  it('returns newest first with totals and quota', async () => {
    const list = await listOf();
    expect(list.items.map((m) => m.name)).toEqual([
      'Eta API',
      'Zeta axb',
      'Epsilon a_b',
      'Delta 100% uptime',
      'Gamma service',
      'Beta API',
      'Alpha API',
    ]);
    expect(list).toMatchObject({ total: 7, nextCursor: null, quota: { used: 7, limit: 25 } });
  });

  it('never includes request bodies, header names or anything secret', async () => {
    const res = await user.get('/api/v1/monitors').expect(200);
    expect(res.text).not.toContain('body-secret');
    expect(res.text).not.toContain('live-secret-token');
    expect(res.text).not.toContain('Authorization');
    for (const item of res.body.data.items as object[]) {
      expect(item).not.toHaveProperty('requestBody');
      expect(item).not.toHaveProperty('headers');
      expect(item).not.toHaveProperty('ownerId');
    }
  });

  it('pages through every monitor exactly once with a stable cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    const pageSizes: number[] = [];
    do {
      const page: MonitorList = await listOf(
        `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      pageSizes.push(page.items.length);
      seen.push(...page.items.map((m) => m.name));
      expect(page.total).toBe(7);
      cursor = page.nextCursor;
    } while (cursor);

    expect(pageSizes).toEqual([3, 3, 1]);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual((await listOf()).items.map((m) => m.name));
  });

  it('stays stable when a monitor is created between pages', async () => {
    const first = await listOf('?limit=4');
    const extra = await createMonitor(user, { name: 'Created mid-pagination' });
    const second = await listOf(`?limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`);
    const names = [...first.items, ...second.items].map((m) => m.name);
    expect(new Set(names).size).toBe(7);
    expect(names).not.toContain('Created mid-pagination');
    await user.delete(`/api/v1/monitors/${extra.id}`).expect(204);
  });

  it('searches names case-insensitively', async () => {
    const list = await listOf('?search=api');
    expect(list.items.map((m) => m.name)).toEqual(['Eta API', 'Beta API', 'Alpha API']);
    expect(list.total).toBe(3);
  });

  it('treats % and _ in the search term literally', async () => {
    expect((await listOf(`?search=${encodeURIComponent('a_b')}`)).items.map((m) => m.name)).toEqual(
      ['Epsilon a_b'],
    );
    expect(
      (await listOf(`?search=${encodeURIComponent('100%')}`)).items.map((m) => m.name),
    ).toEqual(['Delta 100% uptime']);
    expect((await listOf(`?search=${encodeURIComponent('%')}`)).total).toBe(1);
  });

  it('filters by enabled or paused state', async () => {
    expect((await listOf('?state=paused')).items.map((m) => m.name)).toEqual([
      'Gamma service',
      'Beta API',
    ]);
    expect((await listOf('?state=enabled')).total).toBe(5);
  });

  it('filters by stored health status, independently of paused state', async () => {
    expect((await listOf('?status=HEALTHY')).items.map((m) => m.name)).toEqual([
      'Delta 100% uptime',
      'Beta API',
    ]);
    expect((await listOf('?status=DOWN')).items.map((m) => m.name)).toEqual(['Alpha API']);
    expect((await listOf('?status=UNKNOWN')).total).toBe(4);
    expect((await listOf('?status=DEGRADED')).total).toBe(0);
  });

  it('combines filters', async () => {
    const list = await listOf('?status=HEALTHY&state=paused&search=beta');
    expect(list.items.map((m) => m.name)).toEqual(['Beta API']);
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=abc',
    '?state=archived',
    '?status=PAUSED',
    '?cursor=not-a-cursor',
    `?search=${'x'.repeat(101)}`,
  ])('rejects the invalid query %s', async (query) => {
    const res = await user.get(`/api/v1/monitors${query}`).expect(400);
    expect(errorOf(res.body).code).toBe('VALIDATION_ERROR');
  });
});

describe('database constraints', () => {
  let owner: TestUser;

  beforeAll(async () => {
    owner = await h.createUser();
    await owner.get('/api/v1/me').expect(200);
  });

  const insertRaw = (overrides: Record<string, unknown> = {}) => {
    const v = {
      name: 'Raw',
      url: 'https://api.example.com/',
      method: 'GET',
      expected_status_code: 200,
      timeout_ms: 10_000,
      latency_threshold_ms: 2000,
      check_interval_seconds: 300,
      current_status: 'UNKNOWN',
      request_body_ciphertext: null,
      request_body_iv: null,
      request_body_auth_tag: null,
      request_body_key_version: null,
      body_content_type: null,
      consecutive_failures: 0,
      ...overrides,
    };
    return h.db.execute(sql`
      insert into monitors (owner_id, name, url, method, expected_status_code, timeout_ms,
        latency_threshold_ms, check_interval_seconds, current_status, request_body_ciphertext,
        request_body_iv, request_body_auth_tag, request_body_key_version, body_content_type,
        consecutive_failures)
      values (${owner.id}, ${v.name}, ${v.url}, ${v.method}, ${v.expected_status_code},
        ${v.timeout_ms}, ${v.latency_threshold_ms}, ${v.check_interval_seconds},
        ${v.current_status}, ${v.request_body_ciphertext}, ${v.request_body_iv},
        ${v.request_body_auth_tag}, ${v.request_body_key_version}, ${v.body_content_type},
        ${v.consecutive_failures})
      returning id`);
  };

  const CHECK_VIOLATION = '23514';

  it('accepts a valid row and fills database defaults', async () => {
    const [row] = await insertRaw();
    const stored = (await monitorRow((row as { id: string }).id))!;
    expect(stored).toMatchObject({
      enabled: true,
      currentStatus: 'UNKNOWN',
      consecutiveSuccesses: 0,
    });
    expect(stored.nextCheckAt).toBeInstanceOf(Date);
  });

  it.each([
    ['an unsupported method', { method: 'DELETE' }],
    ['an unknown status', { current_status: 'PAUSED' }],
    ['a status code below 100', { expected_status_code: 99 }],
    ['a status code above 599', { expected_status_code: 600 }],
    ['a timeout below 1 s', { timeout_ms: 999 }],
    ['a timeout above 30 s', { timeout_ms: 30_001 }],
    ['a latency threshold above the timeout', { timeout_ms: 1000, latency_threshold_ms: 1001 }],
    ['a zero latency threshold', { latency_threshold_ms: 0 }],
    ['an interval below 60 s', { check_interval_seconds: 59 }],
    ['an interval above one day', { check_interval_seconds: 86_401 }],
    ['a blank name', { name: '   ' }],
    ['a partially stored body', { method: 'POST', request_body_ciphertext: 'abc' }],
    [
      'a body on a GET monitor',
      {
        request_body_ciphertext: 'a',
        request_body_iv: 'b',
        request_body_auth_tag: 'c',
        request_body_key_version: 1,
      },
    ],
    ['a content type without a body', { body_content_type: 'application/json' }],
    ['a negative counter', { consecutive_failures: -1 }],
  ])('rejects %s', async (_label, overrides) => {
    const err = await insertRaw(overrides).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
  });

  it('rejects a name longer than 100 characters', async () => {
    const err = await insertRaw({ name: 'x'.repeat(101) }).catch((e: unknown) => e);
    expect(sqlState(err)).toBe('22001');
  });

  it('rejects a monitor whose owner has no profile', async () => {
    const err = await h.db
      .execute(
        sql`
        insert into monitors (owner_id, name, url, method, expected_status_code, timeout_ms,
          latency_threshold_ms, check_interval_seconds)
        values (${randomUUID()}, 'Orphan', 'https://api.example.com/', 'GET', 200, 10000, 2000, 300)`,
      )
      .catch((e: unknown) => e);
    expect(sqlState(err)).toBe('23503');
  });

  it('rejects duplicate header names that differ only in case', async () => {
    const monitor = await createMonitor(owner, {
      headers: [{ name: 'Authorization', value: SECRET }],
    });
    const err = await h.db
      .execute(
        sql`
        insert into monitor_headers (monitor_id, header_name, value_ciphertext, value_iv,
          value_auth_tag, encryption_key_version)
        values (${monitor.id}, 'AUTHORIZATION', 'x', 'y', 'z', 1)`,
      )
      .catch((e: unknown) => e);
    expect(sqlState(err)).toBe('23505');
  });

  it('has row-level security enabled on both tables', async () => {
    const rows = await h.db.execute<{ relname: string; relrowsecurity: boolean }>(sql`
      select relname, relrowsecurity from pg_class
      where oid in ('public.monitors'::regclass, 'public.monitor_headers'::regclass)
      order by relname`);
    expect([...rows]).toEqual([
      { relname: 'monitor_headers', relrowsecurity: true },
      { relname: 'monitors', relrowsecurity: true },
    ]);
  });

  it('has the owner, pagination and partial scheduler indexes', async () => {
    const rows = await h.db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where tablename = 'monitors' order by indexname`,
    );
    const byName = Object.fromEntries([...rows].map((r) => [r.indexname, r.indexdef]));
    expect(byName.monitors_owner_id_idx).toMatch(/\(owner_id\)/);
    expect(byName.monitors_owner_created_idx).toMatch(
      /\(owner_id, created_at DESC NULLS LAST, id DESC NULLS LAST\)/,
    );
    expect(byName.monitors_due_idx).toMatch(/\(enabled, next_check_at\) WHERE \(enabled = true\)/);
  });

  it('can use the scheduler index for the future "due monitors" query', async () => {
    const plan = await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain select id from monitors
        where enabled = true and next_check_at <= now()
        order by next_check_at limit 50`);
    });
    expect([...plan].map((r) => r['QUERY PLAN']).join('\n')).toContain('monitors_due_idx');
  });
});
