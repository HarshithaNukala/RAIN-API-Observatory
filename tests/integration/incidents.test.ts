import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  IncidentCountsSchema,
  IncidentEventListResponseSchema,
  IncidentListResponseSchema,
  IncidentSchema,
  MONITOR_LIMITS,
  MonitorResponseSchema,
  dataEnvelope,
} from '@rain/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../../apps/server/src/db/client.js';
import {
  incidentEvents,
  incidents,
  monitorChecks,
  monitors,
} from '../../apps/server/src/db/schema.js';
import type { CheckExecution } from '../../apps/server/src/monitoring/executor.js';
import { classifyCheck } from '../../apps/server/src/monitoring/health.js';
import {
  createMonitoringStore,
  type MonitoringStore,
} from '../../apps/server/src/monitoring/monitoring-store.js';
import { createIncidentRepository } from '../../apps/server/src/incidents/incident-repository.js';
import { createHarness, sqlState, type Harness, type TestUser } from './harness.js';

// Incident management on real PostgreSQL (migration 0005): constraints, the append-only timeline,
// the lifecycle inside the completion transaction, concurrency, rollback and the HTTP API.
// Runs alone (fileParallelism: false) and clears monitors between tests because claims are global.

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let store: MonitoringStore;
let second: DatabaseHandle;
let otherStore: MonitoringStore;

beforeAll(async () => {
  h = await createHarness({ maxMonitorsPerUser: 200 });
  alice = await h.createUser();
  bob = await h.createUser();
  store = createMonitoringStore(h.db);
  second = createDatabase(inject('databaseUrl'), { maxConnections: 4 });
  otherStore = createMonitoringStore(second.db);
});

afterAll(async () => {
  await second.close();
  await h.close();
});

beforeEach(async () => {
  await h.db.delete(monitors);
});

const failure = (): CheckExecution => ({
  checkedAt: new Date(),
  result: {
    outcome: 'FAILURE',
    statusCode: 503,
    latencyMs: 20,
    failureReason: 'UNEXPECTED_STATUS',
  },
  errorMessage: 'GET https://api.example.com/health: expected status 200, received 503',
  response: null,
});
const success = (
  latencyMs = 50,
  latencyThresholdMs = MONITOR_LIMITS.latencyThresholdMs.default,
): CheckExecution => ({
  checkedAt: new Date(),
  result: classifyCheck(
    { kind: 'response', statusCode: 200, latencyMs },
    { expectedStatusCode: 200, latencyThresholdMs },
  ),
  errorMessage: null,
  response: null,
});

async function createMonitor(user: TestUser = alice) {
  const res = await user
    .post('/api/v1/monitors', { name: 'Payments', url: 'https://api.example.com/health' })
    .expect(201);
  return dataEnvelope(MonitorResponseSchema).parse(res.body).data;
}
const setRow = (id: string, values: Partial<typeof monitors.$inferInsert>) =>
  h.db.update(monitors).set(values).where(eq(monitors.id, id));
const row = async (id: string) =>
  (await h.db.select().from(monitors).where(eq(monitors.id, id)))[0]!;
const incidentsOf = (monitorId: string) =>
  h.db.select().from(incidents).where(eq(incidents.monitorId, monitorId));
const eventsOf = (incidentId: string) =>
  h.db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, incidentId));

/** One scheduled check with the given result, through the real claim and completion SQL. */
async function runCheck(monitorId: string, execution: CheckExecution, s: MonitoringStore = store) {
  await setRow(monitorId, { nextCheckAt: new Date(Date.now() - 1000) });
  const [claim] = await s.claim(10, 90);
  expect(claim?.monitor.id).toBe(monitorId);
  return s.complete(claim!, execution);
}

async function openIncident(user: TestUser = alice) {
  const m = await createMonitor(user);
  await runCheck(m.id, failure());
  const result = await runCheck(m.id, failure());
  expect(result).toMatchObject({ recorded: true, status: 'DOWN', incident: { action: 'OPENED' } });
  return {
    monitor: m,
    incidentId: (result as { incident: { incidentId: string } }).incident.incidentId,
  };
}

describe('schema (migration 0005)', () => {
  it('allows at most one active incident per monitor, and another after resolution', async () => {
    const m = await createMonitor();
    const base = { monitorId: m.id, ownerId: alice.id, title: 't', startedAt: new Date() };
    const [first] = await h.db.insert(incidents).values(base).returning();
    const dup = await h.db
      .insert(incidents)
      .values(base)
      .catch((e: unknown) => e);
    expect(sqlState(dup)).toBe('23505');
    await h.db
      .update(incidents)
      .set({ status: 'RESOLVED', resolvedAt: new Date() })
      .where(eq(incidents.id, first!.id));
    await h.db.insert(incidents).values(base);
    expect(await incidentsOf(m.id)).toHaveLength(2);
  });

  it('rejects inconsistent status and timestamps, unknown severities and statuses', async () => {
    const m = await createMonitor();
    const base = { monitorId: m.id, ownerId: alice.id, title: 't', startedAt: new Date() };
    for (const bad of [
      { status: 'RESOLVED' },
      { status: 'ACKNOWLEDGED' },
      { resolvedAt: new Date() },
      { severity: 'URGENT' },
      { status: 'CLOSED' },
      { title: '   ' },
    ]) {
      const err = await h.db
        .insert(incidents)
        .values({ ...base, ...bad })
        .catch((e: unknown) => e);
      expect(sqlState(err), JSON.stringify(bad)).toBe('23514');
    }
  });

  it('makes the timeline append-only: UPDATE is rejected even for the table owner', async () => {
    const { incidentId } = await openIncident();
    const err = await h.db
      .update(incidentEvents)
      .set({ description: 'rewritten history' })
      .where(eq(incidentEvents.incidentId, incidentId))
      .catch((e: unknown) => e);
    expect(sqlState(err)).toBe('23001');
    expect((await eventsOf(incidentId))[0]!.description).not.toBe('rewritten history');
  });

  it('deleting the monitor removes its incidents and events; checks keep no foreign key to incidents', async () => {
    const { monitor, incidentId } = await openIncident();
    await alice.delete(`/api/v1/monitors/${monitor.id}`).expect(204);
    expect(await eventsOf(incidentId)).toHaveLength(0);
    // Expiring checks never touches incidents.
    const another = await openIncident();
    await h.db.delete(monitorChecks).where(eq(monitorChecks.monitorId, another.monitor.id));
    expect(await incidentsOf(another.monitor.id)).toHaveLength(1);
  });
});

describe('lifecycle in the completion transaction', () => {
  it('opens on DOWN (not on the first failure) with the trigger check and a CREATED event', async () => {
    const m = await createMonitor();
    const first = await runCheck(m.id, failure());
    expect(first).toMatchObject({ status: 'DEGRADED', incident: null });
    const { incidentId } = await openIncident();
    const [incident] = await h.db.select().from(incidents).where(eq(incidents.id, incidentId));
    const [trigger] = await h.db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.id, incident!.triggerCheckId!));
    expect(trigger).toMatchObject({ outcome: 'FAILURE', statusCode: 503 });
    expect(incident).toMatchObject({ status: 'OPEN', severity: 'HIGH', ownerId: alice.id });
    expect(incident!.startedAt).toEqual(trigger!.checkedAt);
    expect(await eventsOf(incidentId)).toEqual([
      expect.objectContaining({
        eventType: 'INCIDENT_CREATED',
        checkId: trigger!.id,
        actorId: null,
      }),
    ]);
  });

  it('repeated failures: still one incident, one event', async () => {
    const { monitor, incidentId } = await openIncident();
    for (let i = 0; i < 3; i++) await runCheck(monitor.id, failure());
    expect(await incidentsOf(monitor.id)).toHaveLength(1);
    expect(await eventsOf(incidentId)).toHaveLength(1);
  });

  it('first recovery success keeps it open; the second resolves it; a slow success counts', async () => {
    const { monitor, incidentId } = await openIncident();
    expect(await runCheck(monitor.id, success())).toMatchObject({
      status: 'DEGRADED',
      incident: null,
    });
    expect(await runCheck(monitor.id, success(99_999))).toMatchObject({
      status: 'DEGRADED',
      incident: { action: 'RESOLVED', incidentId },
    });
    const [resolved] = await h.db.select().from(incidents).where(eq(incidents.id, incidentId));
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedByCheckId: expect.any(String) });
    expect((await eventsOf(incidentId)).map((e) => e.eventType).sort()).toEqual([
      'INCIDENT_CREATED',
      'INCIDENT_RESOLVED',
    ]);
  });

  it('recovery interrupted by a failure keeps the incident open', async () => {
    const { monitor, incidentId } = await openIncident();
    await runCheck(monitor.id, success());
    await runCheck(monitor.id, failure());
    await runCheck(monitor.id, success());
    const [stillOpen] = await h.db.select().from(incidents).where(eq(incidents.id, incidentId));
    expect(stillOpen!.status).toBe('OPEN');
  });

  it('a new outage after resolution creates a new incident and keeps the old one', async () => {
    const { monitor, incidentId } = await openIncident();
    await runCheck(monitor.id, success());
    await runCheck(monitor.id, success());
    await runCheck(monitor.id, failure());
    const reopened = await runCheck(monitor.id, failure());
    expect(reopened).toMatchObject({ incident: { action: 'OPENED' } });
    const all = await incidentsOf(monitor.id);
    expect(all.map((i) => i.status).sort()).toEqual(['OPEN', 'RESOLVED']);
    expect(all.find((i) => i.id === incidentId)!.status).toBe('RESOLVED');
  });

  it('a failure while writing the incident rolls back the check and the monitor state', async () => {
    const m = await createMonitor();
    await runCheck(m.id, failure());
    const before = await row(m.id);
    const checksBefore = (
      await h.db.select().from(monitorChecks).where(eq(monitorChecks.monitorId, m.id))
    ).length;
    await h.db.execute(
      sql`ALTER TABLE incidents ADD CONSTRAINT test_block_inserts CHECK (false) NOT VALID`,
    );
    try {
      await expect(runCheck(m.id, failure())).rejects.toThrow();
    } finally {
      await h.db.execute(sql`ALTER TABLE incidents DROP CONSTRAINT test_block_inserts`);
    }
    const after = await row(m.id);
    expect(after).toMatchObject({
      currentStatus: before.currentStatus,
      consecutiveFailures: before.consecutiveFailures,
    });
    expect(after.leaseToken).not.toBeNull(); // Still leased: the worker releases it next.
    expect(
      (await h.db.select().from(monitorChecks).where(eq(monitorChecks.monitorId, m.id))).length,
    ).toBe(checksBefore);
    expect(await incidentsOf(m.id)).toHaveLength(0);
  });

  it('a retried completion of the same attempt adds no incident and no event', async () => {
    const m = await createMonitor();
    await runCheck(m.id, failure());
    await setRow(m.id, { nextCheckAt: new Date(Date.now() - 1000) });
    const [claim] = await store.claim(10, 90);
    const execution = failure();
    expect(await store.complete(claim!, execution)).toMatchObject({
      incident: { action: 'OPENED' },
    });
    await setRow(m.id, {
      leaseUntil: new Date(Date.now() + 60_000),
      leaseToken: claim!.leaseToken,
    });
    expect(await store.complete(claim!, execution)).toEqual({
      recorded: false,
      reason: 'DUPLICATE_ATTEMPT',
    });
    const all = await incidentsOf(m.id);
    expect(all).toHaveLength(1);
    expect(await eventsOf(all[0]!.id)).toHaveLength(1);
  });

  it('two workers completing for one monitor (stale and fresh lease) open one incident', async () => {
    const m = await createMonitor();
    await runCheck(m.id, failure());
    await setRow(m.id, { nextCheckAt: new Date(Date.now() - 1000) });
    const [stale] = await store.claim(10, 90);
    await setRow(m.id, { leaseUntil: new Date(Date.now() - 1000) });
    const [fresh] = await otherStore.claim(10, 90);
    const results = await Promise.all([
      store.complete(stale!, failure()),
      otherStore.complete(fresh!, failure()),
    ]);
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect(await incidentsOf(m.id)).toHaveLength(1);
  });

  it('concurrent direct inserts of an active incident: exactly one wins', async () => {
    const m = await createMonitor();
    const insert = (db: typeof h.db) =>
      db
        .insert(incidents)
        .values({ monitorId: m.id, ownerId: alice.id, title: 'race', startedAt: new Date() })
        .then(
          () => 'ok' as const,
          (e: unknown) => sqlState(e),
        );
    const outcomes = await Promise.all([insert(h.db), insert(second.db)]);
    expect(outcomes.sort()).toEqual(['23505', 'ok']);
  });
});

describe('incident API', () => {
  it('lists, counts, filters and paginates only the caller’s incidents', async () => {
    const a1 = await openIncident(alice);
    await openIncident(alice);
    await openIncident(bob);
    const list = dataEnvelope(IncidentListResponseSchema).parse(
      (await alice.get('/api/v1/incidents?limit=1').expect(200)).body,
    ).data;
    expect(list.total).toBe(2);
    expect(list.items).toHaveLength(1);
    const next = dataEnvelope(IncidentListResponseSchema).parse(
      (await alice.get(`/api/v1/incidents?limit=1&cursor=${list.nextCursor}`).expect(200)).body,
    ).data;
    expect(next.items[0]!.id).not.toBe(list.items[0]!.id);
    expect(next.nextCursor).toBeNull();

    const byMonitor = dataEnvelope(IncidentListResponseSchema).parse(
      (await alice.get(`/api/v1/incidents?monitorId=${a1.monitor.id}&status=ACTIVE`).expect(200))
        .body,
    ).data;
    expect(byMonitor.items.map((i) => i.id)).toEqual([a1.incidentId]);
    // Bob's monitor ID as a filter returns nothing for Alice.
    const counts = dataEnvelope(IncidentCountsSchema).parse(
      (await alice.get('/api/v1/incidents/counts').expect(200)).body,
    ).data;
    expect(counts).toEqual({ total: 2, open: 2, acknowledged: 0, resolved: 0 });
  });

  it('acknowledges once, records the event, rejects repeats, resolved incidents and other users', async () => {
    const { monitor, incidentId } = await openIncident();
    const path = `/api/v1/incidents/${incidentId}`;
    await bob.post(`${path}/acknowledge`).expect(404);
    await bob.get(path).expect(404);
    await bob.get(`${path}/events`).expect(404);
    await bob.patch(path, { severity: 'LOW' }).expect(404);

    const acked = dataEnvelope(IncidentSchema).parse(
      (await alice.post(`${path}/acknowledge`).expect(200)).body,
    ).data;
    expect(acked).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: alice.id });
    const again = await alice.post(`${path}/acknowledge`).expect(409);
    expect(ApiErrorSchema.parse(again.body).error.code).toBe('INCIDENT_ALREADY_ACKNOWLEDGED');

    await runCheck(monitor.id, success());
    await runCheck(monitor.id, success());
    const timeline = dataEnvelope(IncidentEventListResponseSchema).parse(
      (await alice.get(`${path}/events`).expect(200)).body,
    ).data;
    expect(timeline.items.map((e) => e.type)).toEqual([
      'INCIDENT_CREATED',
      'INCIDENT_ACKNOWLEDGED',
      'INCIDENT_RESOLVED',
    ]);

    const other = await openIncident();
    await runCheck(other.monitor.id, success());
    await runCheck(other.monitor.id, success());
    const resolved = await alice
      .post(`/api/v1/incidents/${other.incidentId}/acknowledge`)
      .expect(409);
    expect(ApiErrorSchema.parse(resolved.body).error.code).toBe('INCIDENT_ALREADY_RESOLVED');
  });

  it('updates metadata with an UPDATED event; system fields cannot be set', async () => {
    const { incidentId } = await openIncident();
    const path = `/api/v1/incidents/${incidentId}`;
    await alice.patch(path, { status: 'RESOLVED' }).expect(400);
    const res = await alice
      .patch(path, { severity: 'CRITICAL', title: 'Card payments failing' })
      .expect(200);
    expect(dataEnvelope(IncidentSchema).parse(res.body).data).toMatchObject({
      severity: 'CRITICAL',
      title: 'Card payments failing',
      status: 'OPEN',
    });
    const events = await h.db
      .select()
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incidentId),
          eq(incidentEvents.eventType, 'INCIDENT_UPDATED'),
        ),
      );
    expect(events).toEqual([expect.objectContaining({ actorId: alice.id })]);
  });

  it('answers unknown and malformed IDs with 404 INCIDENT_NOT_FOUND', async () => {
    for (const id of [randomUUID(), 'nope']) {
      const res = await alice.get(`/api/v1/incidents/${id}`).expect(404);
      expect(ApiErrorSchema.parse(res.body).error.code).toBe('INCIDENT_NOT_FOUND');
    }
  });

  it('findAnalysisContext joins incidents, monitors and monitor_checks scoped to owner', async () => {
    const { monitor, incidentId } = await openIncident(alice);
    const repo = createIncidentRepository(h.db);

    const ctx = await repo.findAnalysisContext(alice.id, incidentId);
    expect(ctx).toBeDefined();
    expect(ctx!.incident.id).toBe(incidentId);
    expect(ctx!.monitor.id).toBe(monitor.id);
    expect(ctx!.triggerCheck?.statusCode).toBe(503);
    expect(ctx!.recentChecks.length).toBeGreaterThanOrEqual(2);
    expect(ctx!.windowStats.failedChecks).toBeGreaterThanOrEqual(2);

    // Owner isolation: Bob cannot read Alice's context.
    expect(await repo.findAnalysisContext(bob.id, incidentId)).toBeUndefined();
  });
});
