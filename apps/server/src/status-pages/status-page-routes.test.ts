import { randomUUID } from 'node:crypto';
import { ApiErrorSchema, PublicStatusPageSchema, StatusPageSchema } from '@rain/shared';
import { pino } from 'pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import type { ProfileStore } from '../db/profiles.js';
import { stubAnalyticsService } from '../test-support/analytics-service-stub.js';
import { client } from '../test-support/http.js';
import { stubIncidentService } from '../test-support/incident-service-stub.js';
import {
  createInMemoryMonitorRepository,
  type InMemoryMonitorRepository,
} from '../test-support/in-memory-monitor-repository.js';
import { createInMemoryStatusPageRepository } from '../test-support/in-memory-status-page-repository.js';
import { stubMonitorService } from '../test-support/monitor-service-stub.js';
import { stubNotificationService } from '../test-support/notification-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from '../test-support/tokens.js';
import { createStatusPageService } from './status-page-service.js';

const alice = randomUUID();
const bob = randomUUID();
let aliceAuth: string;
let bobAuth: string;
let signer: Awaited<ReturnType<typeof createTestSigner>>;
let repo: InMemoryMonitorRepository;
let app: ReturnType<typeof client>;

const profiles: ProfileStore = {
  ensure: async (id) => ({
    id,
    displayName: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }),
};

beforeAll(async () => {
  signer = await createTestSigner();
  aliceAuth = `Bearer ${await signer.sign({ sub: alice })}`;
  bobAuth = `Bearer ${await signer.sign({ sub: bob })}`;
});

function build(publicRateLimitPerMinute = 1000) {
  repo = createInMemoryMonitorRepository();
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
      profiles,
      monitors: stubMonitorService(),
      incidents: stubIncidentService(),
      analytics: stubAnalyticsService(),
      notifications: stubNotificationService(),
      statusPages: createStatusPageService({
        repository: createInMemoryStatusPageRepository(repo),
        profiles,
      }),
      readiness: async () => ({ database: 'ok', auth: 'ok' }),
      publicRateLimitPerMinute,
    }),
  );
}

beforeEach(() => {
  app = build();
});

async function createPage(slug = 'acme') {
  const res = await app
    .post('/api/v1/status-pages')
    .set('Authorization', aliceAuth)
    .send({ title: 'Acme status', slug })
    .expect(201);
  expect(res.headers.location).toBe(`/api/v1/status-pages/${res.body.data.id}`);
  return StatusPageSchema.parse(res.body.data);
}

const monitor = (ownerId = alice) =>
  repo.insert({
    ownerId,
    name: 'internal-name',
    url: 'https://internal.example.com/x',
    method: 'GET',
    expectedStatusCode: 200,
    timeoutMs: 5000,
    latencyThresholdMs: 1000,
    checkIntervalSeconds: 60,
    currentStatus: 'HEALTHY',
  });

describe('public status page API', () => {
  it('serves published pages without authentication, uncached and not indexed', async () => {
    const page = await createPage();
    const m = await monitor();
    await app
      .post(`/api/v1/status-pages/${page.id}/monitors`)
      .set('Authorization', aliceAuth)
      .send({ monitorId: m.id, displayName: 'API' })
      .expect(201);
    await app.get('/api/v1/public/status-pages/acme').expect(404);
    await app
      .post(`/api/v1/status-pages/${page.id}/publish`)
      .set('Authorization', aliceAuth)
      .expect(200);

    const res = await app.get('/api/v1/public/status-pages/acme').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    const view = PublicStatusPageSchema.parse(res.body.data);
    expect(view).toMatchObject({
      title: 'Acme status',
      overallStatus: 'HEALTHY',
      services: [{ name: 'API', status: 'HEALTHY' }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/internal|[0-9a-f]{8}-[0-9a-f]{4}-/);

    await app
      .post(`/api/v1/status-pages/${page.id}/unpublish`)
      .set('Authorization', aliceAuth)
      .expect(200);
    const gone = await app.get('/api/v1/public/status-pages/acme').expect(404);
    expect(ApiErrorSchema.parse(gone.body).error.code).toBe('STATUS_PAGE_NOT_FOUND');
    expect(gone.headers['cache-control']).toBe('no-store');
  });

  it.each(['NO', 'a', '../etc', 'app', 'x'.repeat(80), 'never-created'])(
    'answers slug %s with 404',
    async (slug) => {
      const res = await app
        .get(`/api/v1/public/status-pages/${encodeURIComponent(slug)}`)
        .expect(404);
      expect(ApiErrorSchema.parse(res.body).error.code).toBe('STATUS_PAGE_NOT_FOUND');
    },
  );

  it('is rate-limited per client IP', async () => {
    app = build(2);
    await app.get('/api/v1/public/status-pages/acme').expect(404);
    await app.get('/api/v1/public/status-pages/acme').expect(404);
    const res = await app.get('/api/v1/public/status-pages/acme').expect(429);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('RATE_LIMITED');
  });
});

describe('status page management API', () => {
  it('requires authentication for every management route', async () => {
    const id = randomUUID();
    await app.get('/api/v1/status-pages').expect(401);
    await app.post('/api/v1/status-pages').send({ title: 'x' }).expect(401);
    await app.get(`/api/v1/status-pages/${id}`).expect(401);
    await app.get(`/api/v1/status-pages/${id}/preview`).expect(401);
    await app.post(`/api/v1/status-pages/${id}/publish`).expect(401);
    await app.delete(`/api/v1/status-pages/${id}`).expect(401);
  });

  it('isolates users and refuses other users’ monitors', async () => {
    const page = await createPage();
    await app.get(`/api/v1/status-pages/${page.id}`).set('Authorization', bobAuth).expect(404);
    await app
      .post(`/api/v1/status-pages/${page.id}/publish`)
      .set('Authorization', bobAuth)
      .expect(404);
    await app
      .get(`/api/v1/status-pages/${page.id}/preview`)
      .set('Authorization', bobAuth)
      .expect(404);
    const bobs = await monitor(bob);
    const res = await app
      .post(`/api/v1/status-pages/${page.id}/monitors`)
      .set('Authorization', aliceAuth)
      .send({ monitorId: bobs.id })
      .expect(404);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('MONITOR_NOT_FOUND');
    const list = await app.get('/api/v1/status-pages').set('Authorization', bobAuth).expect(200);
    expect(list.body.data.items).toEqual([]);
  });

  it('validates input with the shared schemas', async () => {
    const page = await createPage();
    for (const body of [
      {},
      { title: '' },
      { title: 'x', slug: 'Bad Slug!' },
      { title: 'x', slug: 'api' },
      { title: 'a\nb' },
      { title: 'x', extra: 1 },
    ]) {
      const res = await app.post('/api/v1/status-pages').set('Authorization', aliceAuth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    await app
      .patch(`/api/v1/status-pages/${page.id}`)
      .set('Authorization', aliceAuth)
      .send({})
      .expect(400);
    await app
      .post(`/api/v1/status-pages/${page.id}/monitors`)
      .set('Authorization', aliceAuth)
      .send({ monitorId: 'nope' })
      .expect(400);
    await app
      .put(`/api/v1/status-pages/${page.id}/monitors/order`)
      .set('Authorization', aliceAuth)
      .send({ monitorIds: ['x'] })
      .expect(400);
    const taken = await app
      .post('/api/v1/status-pages')
      .set('Authorization', aliceAuth)
      .send({ title: 'x', slug: 'acme' })
      .expect(409);
    expect(ApiErrorSchema.parse(taken.body).error.code).toBe('STATUS_PAGE_SLUG_TAKEN');
  });

  it('reorders through PUT /monitors/order and renames and removes monitors', async () => {
    const page = await createPage();
    const a = await monitor();
    const b = await monitor();
    for (const m of [a, b]) {
      await app
        .post(`/api/v1/status-pages/${page.id}/monitors`)
        .set('Authorization', aliceAuth)
        .send({ monitorId: m.id })
        .expect(201);
    }
    const ordered = await app
      .put(`/api/v1/status-pages/${page.id}/monitors/order`)
      .set('Authorization', aliceAuth)
      .send({ monitorIds: [b.id, a.id] })
      .expect(200);
    expect(ordered.body.data.monitors.map((m: { monitorId: string }) => m.monitorId)).toEqual([
      b.id,
      a.id,
    ]);
    const renamed = await app
      .patch(`/api/v1/status-pages/${page.id}/monitors/${a.id}`)
      .set('Authorization', aliceAuth)
      .send({ displayName: 'Website' })
      .expect(200);
    expect(renamed.body.data.monitors[1].displayName).toBe('Website');
    await app
      .delete(`/api/v1/status-pages/${page.id}/monitors/${a.id}`)
      .set('Authorization', aliceAuth)
      .expect(200);
    await app.delete(`/api/v1/status-pages/${page.id}`).set('Authorization', aliceAuth).expect(204);
    await app.get(`/api/v1/status-pages/${page.id}`).set('Authorization', aliceAuth).expect(404);
  });
});
