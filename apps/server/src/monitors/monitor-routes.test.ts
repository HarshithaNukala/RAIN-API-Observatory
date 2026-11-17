import { randomUUID } from 'node:crypto';
import { ApiErrorSchema, type Monitor, type MonitorList } from '@rain/shared';
import { pino } from 'pino';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { AppError } from '../errors.js';
import { client } from '../test-support/http.js';
import { stubMonitorService } from '../test-support/monitor-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from '../test-support/tokens.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { monitorNotFound, type MonitorService } from './monitor-service.js';

const userId = randomUUID();
const monitorId = randomUUID();
let auth: string;
let signer: Awaited<ReturnType<typeof createTestSigner>>;

const monitor: Monitor = {
  id: monitorId,
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
  nextCheckAt: '2026-11-16T10:00:00.000Z',
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  requestBody: null,
  bodyContentType: null,
  headers: [],
};

beforeAll(async () => {
  signer = await createTestSigner();
  auth = `Bearer ${await signer.sign({ sub: userId })}`;
});

function appWith(service: Partial<MonitorService>) {
  return client(
    createApp({
      logger: pino({ level: 'silent' }),
      corsOrigins: [],
      trustProxy: 0,
      verifyAccessToken: createTokenVerifier({
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks: signer.jwks,
      }),
      profiles: { ensure: () => Promise.reject(new Error('unused')) },
      monitors: stubMonitorService(service),
      readiness: async () => ({ database: 'ok', auth: 'ok' }),
    }),
  );
}

describe('monitor routes', () => {
  it('POST /monitors validates, passes the authenticated user ID, and returns 201 + Location', async () => {
    const create = vi.fn<MonitorService['create']>(async () => monitor);
    const res = await appWith({ create })
      .post('/api/v1/monitors')
      .set('Authorization', auth)
      .send({ name: '  Payments API ', url: 'https://api.example.com/health' })
      .expect(201);

    expect(res.headers.location).toBe(`/api/v1/monitors/${monitorId}`);
    expect(res.body).toEqual({ data: monitor });
    expect(create).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        name: 'Payments API',
        method: 'GET',
        timeoutMs: 10_000,
        headers: [],
      }),
    );
  });

  it('rejects invalid input with field details before reaching the service', async () => {
    const create = vi.fn<MonitorService['create']>();
    const res = await appWith({ create })
      .post('/api/v1/monitors')
      .set('Authorization', auth)
      .send({ name: '', url: 'http://10.0.0.1/', checkIntervalSeconds: 5 })
      .expect(400);

    const { code, details } = ApiErrorSchema.parse(res.body).error;
    expect(code).toBe('VALIDATION_ERROR');
    expect((details as Array<{ path: string }>).map((d) => d.path).sort()).toEqual([
      'checkIntervalSeconds',
      'name',
      'url',
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-object body', async () => {
    const create = vi.fn<MonitorService['create']>();
    await appWith({ create }).post('/api/v1/monitors').set('Authorization', auth).expect(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('GET /monitors parses filters from the query string', async () => {
    const list = vi.fn<MonitorService['list']>(async (): Promise<MonitorList> => ({
      items: [],
      nextCursor: null,
      total: 0,
      quota: { used: 0, limit: 25 },
    }));
    await appWith({ list })
      .get('/api/v1/monitors?search=%20pay%20&state=paused&status=DOWN&limit=10')
      .set('Authorization', auth)
      .expect(200);
    expect(list).toHaveBeenCalledWith(userId, {
      search: 'pay',
      state: 'paused',
      status: 'DOWN',
      limit: 10,
    });
  });

  it('answers a malformed monitor ID with 404 without calling the service', async () => {
    const get = vi.fn<MonitorService['get']>();
    const res = await appWith({ get })
      .get('/api/v1/monitors/not-a-uuid')
      .set('Authorization', auth)
      .expect(404);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('MONITOR_NOT_FOUND');
    expect(get).not.toHaveBeenCalled();
  });

  it('maps the service not-found error to the standard 404 body', async () => {
    const res = await appWith({ get: () => Promise.reject(monitorNotFound()) })
      .get(`/api/v1/monitors/${monitorId}`)
      .set('Authorization', auth)
      .expect(404);
    expect(ApiErrorSchema.parse(res.body).error).toMatchObject({
      code: 'MONITOR_NOT_FOUND',
      message: 'Monitor not found',
      requestId: expect.any(String),
    });
  });

  it('maps the quota error to 409', async () => {
    const res = await appWith({
      create: () => Promise.reject(new AppError(409, 'MONITOR_LIMIT_REACHED', 'Limit reached')),
    })
      .post('/api/v1/monitors')
      .set('Authorization', auth)
      .send({ name: 'x', url: 'https://api.example.com/' })
      .expect(409);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('MONITOR_LIMIT_REACHED');
  });

  it('PATCH /monitors/:id passes only the supplied fields', async () => {
    const update = vi.fn<MonitorService['update']>(async () => monitor);
    await appWith({ update })
      .patch(`/api/v1/monitors/${monitorId}`)
      .set('Authorization', auth)
      .send({ checkIntervalSeconds: 600 })
      .expect(200);
    expect(update).toHaveBeenCalledWith(userId, monitorId, { checkIntervalSeconds: 600 });
  });

  it('PATCH /monitors/:id/headers passes explicit upserts and removals', async () => {
    const updateHeaders = vi.fn<MonitorService['updateHeaders']>(async () => monitor);
    const res = await appWith({ updateHeaders })
      .patch(`/api/v1/monitors/${monitorId}/headers`)
      .set('Authorization', auth)
      .send({ upsert: [{ name: 'Authorization', value: 'Bearer s3cret' }], remove: ['X-Old'] })
      .expect(200);
    expect(updateHeaders).toHaveBeenCalledWith(userId, monitorId, {
      upsert: [{ name: 'Authorization', value: 'Bearer s3cret' }],
      remove: ['X-Old'],
    });
    expect(res.text).not.toContain('s3cret');
  });

  it('pause, resume and delete call the service for the authenticated user', async () => {
    const pause = vi.fn<MonitorService['pause']>(async () => ({ ...monitor, enabled: false }));
    const resume = vi.fn<MonitorService['resume']>(async () => monitor);
    const remove = vi.fn<MonitorService['remove']>(async () => {});
    const http = appWith({ pause, resume, remove });

    const paused = await http
      .post(`/api/v1/monitors/${monitorId}/pause`)
      .set('Authorization', auth)
      .expect(200);
    expect(paused.body.data.enabled).toBe(false);
    await http.post(`/api/v1/monitors/${monitorId}/resume`).set('Authorization', auth).expect(200);
    const deleted = await http
      .delete(`/api/v1/monitors/${monitorId}`)
      .set('Authorization', auth)
      .expect(204);
    expect(deleted.text).toBe('');

    for (const fn of [pause, resume, remove]) expect(fn).toHaveBeenCalledWith(userId, monitorId);
  });

  it('marks every response as uncacheable', async () => {
    const res = await appWith({ get: async () => monitor })
      .get(`/api/v1/monitors/${monitorId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not expose a manual check endpoint', async () => {
    await appWith({})
      .post(`/api/v1/monitors/${monitorId}/check`)
      .set('Authorization', auth)
      .expect(404);
  });
});

describe('pagination cursor', () => {
  it('round-trips a position exactly', () => {
    const cursor = { createdAt: new Date('2026-11-16T10:00:00.123Z'), id: monitorId };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    '',
    'garbage',
    Buffer.from('{"t":"yesterday","i":"x"}').toString('base64url'),
    Buffer.from('[]').toString('base64url'),
  ])('rejects the malformed cursor %j as a validation error', (raw) => {
    expect(() => decodeCursor(raw)).toThrow(
      expect.objectContaining({ status: 400, code: 'VALIDATION_ERROR' }),
    );
  });
});
