import {
  ApiErrorSchema,
  MonitorResponseSchema,
  PublicStatusPageSchema,
  StatusPageSchema,
  dataEnvelope,
} from '@rain/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  incidents,
  monitorChecks,
  monitors,
  statusPageMonitors,
  statusPages,
} from '../../apps/server/src/db/schema.js';
import { client } from '../../apps/server/src/test-support/http.js';
import { createHarness, sqlState, type Harness, type TestUser } from './harness.js';

// Public status pages on real PostgreSQL (migration 0007): slug uniqueness and format, the
// same-owner trigger, cascades, the public SQL (daily counts, incident filtering) and the HTTP API
// with and without authentication.

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let anonymous: ReturnType<typeof client>;

beforeAll(async () => {
  h = await createHarness({ maxMonitorsPerUser: 100 });
  alice = await h.createUser();
  bob = await h.createUser();
  anonymous = client(h.app);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(statusPages);
  await h.db.delete(monitors);
});

async function createMonitor(user: TestUser = alice, name = 'internal-payments') {
  const res = await user
    .post('/api/v1/monitors', { name, url: 'https://api.example.com/health?key=s3cr3t' })
    .expect(201);
  return dataEnvelope(MonitorResponseSchema).parse(res.body).data;
}
async function createPage(user: TestUser = alice, slug = 'acme') {
  const res = await user.post('/api/v1/status-pages', { title: 'Acme status', slug }).expect(201);
  return dataEnvelope(StatusPageSchema).parse(res.body).data;
}

describe('schema (migration 0007)', () => {
  it('enforces unique, well-formed slugs', async () => {
    await createPage(alice, 'acme');
    const res = await bob.post('/api/v1/status-pages', { title: 'x', slug: 'acme' }).expect(409);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('STATUS_PAGE_SLUG_TAKEN');
    const bad = await h.db
      .insert(statusPages)
      .values({ ownerId: alice.id, title: 't', slug: 'Bad--Slug' })
      .catch((e: unknown) => e);
    expect(sqlState(bad)).toBe('23514');
  });

  it('rejects another owner’s monitor and duplicates at the database level', async () => {
    const page = await createPage();
    const bobs = await createMonitor(bob);
    const cross = await h.db
      .insert(statusPageMonitors)
      .values({ statusPageId: page.id, monitorId: bobs.id, displayName: 'x', position: 0 })
      .catch((e: unknown) => e);
    expect(sqlState(cross)).toBe('23503');
    const mine = await createMonitor();
    await h.db
      .insert(statusPageMonitors)
      .values({ statusPageId: page.id, monitorId: mine.id, displayName: 'x', position: 0 });
    const dup = await h.db
      .insert(statusPageMonitors)
      .values({ statusPageId: page.id, monitorId: mine.id, displayName: 'y', position: 1 })
      .catch((e: unknown) => e);
    expect(sqlState(dup)).toBe('23505');
  });

  it('cascades: deleting a page or a monitor removes the selections', async () => {
    const page = await createPage();
    const a = await createMonitor();
    const b = await createMonitor();
    for (const m of [a, b])
      await alice.post(`/api/v1/status-pages/${page.id}/monitors`, { monitorId: m.id }).expect(201);
    await alice.delete(`/api/v1/monitors/${a.id}`).expect(204);
    expect(await h.db.select().from(statusPageMonitors)).toHaveLength(1);
    await alice.delete(`/api/v1/status-pages/${page.id}`).expect(204);
    expect(await h.db.select().from(statusPageMonitors)).toHaveLength(0);
  });
});

describe('public API (SQL)', () => {
  it('serves only published pages, without authentication, with safe data only', async () => {
    const page = await createPage();
    const api = await createMonitor(alice, 'internal-payments');
    const hidden = await createMonitor(alice, 'internal-admin');
    await alice
      .post(`/api/v1/status-pages/${page.id}/monitors`, {
        monitorId: api.id,
        displayName: 'Payments API',
      })
      .expect(201);
    await h.db
      .update(monitors)
      .set({ currentStatus: 'DEGRADED', lastCheckedAt: new Date() })
      .where(eq(monitors.id, api.id));
    await h.db.insert(monitorChecks).values([
      {
        monitorId: api.id,
        checkedAt: new Date(),
        outcome: 'SUCCESS',
        statusCode: 200,
        latencyMs: 40,
      },
      {
        monitorId: api.id,
        checkedAt: new Date(Date.now() - 60_000),
        outcome: 'FAILURE',
        failureReason: 'TIMEOUT',
      },
      {
        monitorId: api.id,
        checkedAt: new Date(Date.now() - 120_000),
        outcome: 'FAILURE',
        failureReason: 'BLOCKED_DESTINATION',
      },
    ]);
    for (const m of [api, hidden]) {
      await h.db.insert(incidents).values({
        monitorId: m.id,
        ownerId: alice.id,
        title: `${m.name} is down`,
        description: 'internal detail: GET https://api.example.com/health?key=s3cr3t',
        startedAt: new Date(Date.now() - 3600_000),
      });
    }

    await anonymous.get('/api/v1/public/status-pages/acme').expect(404);
    await alice.post(`/api/v1/status-pages/${page.id}/publish`).expect(200);
    const res = await anonymous.get('/api/v1/public/status-pages/acme').expect(200);
    const view = PublicStatusPageSchema.parse(res.body.data);
    expect(view.overallStatus).toBe('DEGRADED');
    expect(view.services).toEqual([
      expect.objectContaining({
        key: 's1',
        name: 'Payments API',
        status: 'DEGRADED',
        availabilityPercent: 50,
      }),
    ]);
    expect(view.services[0]!.days.at(-1)!.availabilityPercent).toBe(50);
    expect(view.incidents).toHaveLength(1);
    expect(view.incidents[0]).toMatchObject({
      title: 'Payments API disruption',
      status: 'INVESTIGATING',
    });
    const raw = JSON.stringify(res.body);
    for (const leak of ['internal', 's3cr3t', 'api.example.com', api.id, page.id, alice.id])
      expect(raw).not.toContain(leak);

    await alice.post(`/api/v1/status-pages/${page.id}/unpublish`).expect(200);
    await anonymous.get('/api/v1/public/status-pages/acme').expect(404);
  });

  it('management stays owner-only', async () => {
    const page = await createPage();
    await bob.get(`/api/v1/status-pages/${page.id}`).expect(404);
    await bob.patch(`/api/v1/status-pages/${page.id}`, { title: 'hijack' }).expect(404);
    await bob.delete(`/api/v1/status-pages/${page.id}`).expect(404);
    await anonymous.get(`/api/v1/status-pages/${page.id}`).expect(401);
  });
});
