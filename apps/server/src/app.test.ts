import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  LivenessSchema,
  MeSchema,
  ReadinessSchema,
  dataEnvelope,
  type Profile,
} from '@rain/shared';
import { pino } from 'pino';
import { client } from './test-support/http.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from './app.js';
import { createTokenVerifier } from './auth/verify-token.js';
import type { ProfileStore } from './db/profiles.js';
import { stubMonitorService } from './test-support/monitor-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from './test-support/tokens.js';

/** In-memory stand-in for the Postgres-backed store; the real one is covered by integration tests. */
function memoryProfileStore(): ProfileStore & { calls: string[] } {
  const rows = new Map<string, Profile>();
  const calls: string[] = [];
  return {
    calls,
    async ensure(id) {
      calls.push(id);
      const now = new Date().toISOString();
      const existing = rows.get(id) ?? { id, displayName: null, createdAt: now, updatedAt: now };
      rows.set(id, existing);
      return existing;
    },
  };
}

let signer: Awaited<ReturnType<typeof createTestSigner>>;

beforeAll(async () => {
  signer = await createTestSigner();
});

function buildApp(overrides: Partial<AppDependencies> = {}) {
  const profiles = memoryProfileStore();
  const app = createApp({
    logger: pino({ level: 'silent' }),
    corsOrigins: ['http://localhost:5173'],
    trustProxy: 0,
    verifyAccessToken: createTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: signer.jwks,
    }),
    profiles,
    monitors: stubMonitorService(),
    readiness: async () => ({ database: 'ok', auth: 'ok' }),
    ...overrides,
  });
  return { app, profiles };
}

function expectErrorBody(body: unknown, code: string) {
  const parsed = ApiErrorSchema.parse(body);
  expect(parsed.error.code).toBe(code);
  expect(parsed.error.requestId).toBeTruthy();
  return parsed;
}

describe('health endpoints', () => {
  it('GET /healthz reports liveness without auth', async () => {
    const res = await client(buildApp().app).get('/healthz').expect(200);
    expect(LivenessSchema.parse(res.body).status).toBe('ok');
  });

  it('GET /readyz returns 200 when every dependency is ok', async () => {
    const res = await client(buildApp().app).get('/readyz').expect(200);
    expect(ReadinessSchema.parse(res.body)).toEqual({
      status: 'ready',
      checks: { database: 'ok', auth: 'ok' },
    });
  });

  it('GET /readyz returns 503 when the database is down', async () => {
    const { app } = buildApp({ readiness: async () => ({ database: 'error', auth: 'ok' }) });
    const res = await client(app).get('/readyz').expect(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'error', auth: 'ok' } });
  });
});

describe('GET /api/v1/me', () => {
  it('returns 401 with a standard error body when no token is sent', async () => {
    const { app, profiles } = buildApp();
    const res = await client(app).get('/api/v1/me').expect(401);
    expectErrorBody(res.body, 'UNAUTHENTICATED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(profiles.calls).toHaveLength(0);
  });

  it('returns 401 for a non-Bearer Authorization header', async () => {
    const res = await client(buildApp().app)
      .get('/api/v1/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);
    expect(expectErrorBody(res.body, 'UNAUTHENTICATED').error.message).toMatch(/Malformed/);
  });

  it('returns 401 for an invalid token', async () => {
    const res = await client(buildApp().app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
    expectErrorBody(res.body, 'UNAUTHENTICATED');
  });

  it('returns 401 TOKEN_EXPIRED for an expired token', async () => {
    const token = await signer.sign({}, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    const res = await client(buildApp().app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expectErrorBody(res.body, 'TOKEN_EXPIRED');
  });

  it('returns the user and their profile for a valid token', async () => {
    const { app, profiles } = buildApp();
    const sub = randomUUID();
    const token = await signer.sign({ sub, email: 'grace@example.com' });
    const res = await client(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = dataEnvelope(MeSchema).parse(res.body);
    expect(body.data).toMatchObject({ id: sub, email: 'grace@example.com', profile: { id: sub } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(profiles.calls).toEqual([sub]);
  });
});

describe('cross-cutting behaviour', () => {
  it('returns a standard 404 for unknown routes', async () => {
    const res = await client(buildApp().app).get('/nope').expect(404);
    expectErrorBody(res.body, 'NOT_FOUND');
  });

  it('requires auth before revealing whether an /api route exists', async () => {
    const res = await client(buildApp().app).get('/api/v1/does-not-exist').expect(401);
    expectErrorBody(res.body, 'UNAUTHENTICATED');
  });

  it('rejects malformed JSON with a validation error', async () => {
    const res = await client(buildApp().app)
      .post('/api/v1/me')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expectErrorBody(res.body, 'VALIDATION_ERROR');
  });

  it('rejects bodies over the size limit with 413', async () => {
    const res = await client(buildApp().app)
      .post('/api/v1/me')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(300 * 1024) }))
      .expect(413);
    expectErrorBody(res.body, 'PAYLOAD_TOO_LARGE');
  });

  it('echoes a well-formed X-Request-Id and uses it in error bodies', async () => {
    const res = await client(buildApp().app).get('/nope').set('X-Request-Id', 'trace-abc.123');
    expect(res.headers['x-request-id']).toBe('trace-abc.123');
    expect(res.body.error.requestId).toBe('trace-abc.123');
  });

  it('replaces an unsafe X-Request-Id with a generated one', async () => {
    const res = await client(buildApp().app).get('/healthz').set('X-Request-Id', 'bad id <script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rate-limits /api requests per client', async () => {
    const { app } = buildApp({ rateLimitPerMinute: 2 });
    await client(app).get('/api/v1/me').expect(401);
    await client(app).get('/api/v1/me').expect(401);
    const res = await client(app).get('/api/v1/me').expect(429);
    expectErrorBody(res.body, 'RATE_LIMITED');
  });

  it('allows CORS only for configured origins', async () => {
    const { app } = buildApp();
    const allowed = await client(app).get('/healthz').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await client(app).get('/healthz').set('Origin', 'https://evil.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and hides the framework', async () => {
    const res = await client(buildApp().app).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('hides internal error details behind a 500 INTERNAL_ERROR', async () => {
    const { app } = buildApp({
      profiles: {
        ensure: () => Promise.reject(new Error('connection to 10.0.0.5 refused')),
      },
    });
    const token = await signer.sign();
    const res = await client(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(500);
    const body = expectErrorBody(res.body, 'INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });
});
