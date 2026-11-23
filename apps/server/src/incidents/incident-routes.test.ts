import { stubStatusPageService } from '../test-support/status-page-service-stub.js';
import { stubNotificationService } from '../test-support/notification-service-stub.js';
import { stubAnalyticsService } from '../test-support/analytics-service-stub.js';
import { randomUUID } from 'node:crypto';
import { ApiErrorSchema, type Incident } from '@rain/shared';
import { pino } from 'pino';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { AppError } from '../errors.js';
import { client } from '../test-support/http.js';
import { stubIncidentService } from '../test-support/incident-service-stub.js';
import { stubMonitorService } from '../test-support/monitor-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from '../test-support/tokens.js';
import type { IncidentService } from './incident-service.js';

const userId = randomUUID();
const incidentId = randomUUID();
let auth: string;
let signer: Awaited<ReturnType<typeof createTestSigner>>;

const incident: Incident = {
  id: incidentId,
  monitor: { id: randomUUID(), name: 'Payments', currentStatus: 'DOWN', enabled: true },
  title: 'Payments is down',
  description: null,
  severity: 'HIGH',
  status: 'OPEN',
  startedAt: '2026-11-18T10:00:00.000Z',
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  triggerCheckId: randomUUID(),
  resolvedByCheckId: null,
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
};

beforeAll(async () => {
  signer = await createTestSigner();
  auth = `Bearer ${await signer.sign({ sub: userId })}`;
});

function appWith(service: Partial<IncidentService>) {
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
      monitors: stubMonitorService(),
      incidents: stubIncidentService(service),
      analytics: stubAnalyticsService(),
      notifications: stubNotificationService(),
      statusPages: stubStatusPageService(),
      readiness: async () => ({ database: 'ok', auth: 'ok' }),
    }),
  );
}

describe('incident routes', () => {
  it('require authentication on every endpoint', async () => {
    const app = appWith({});
    await app.get('/api/v1/incidents').expect(401);
    await app.get('/api/v1/incidents/counts').expect(401);
    await app.get(`/api/v1/incidents/${incidentId}`).expect(401);
    await app.get(`/api/v1/incidents/${incidentId}/events`).expect(401);
    await app.post(`/api/v1/incidents/${incidentId}/acknowledge`).expect(401);
    await app.patch(`/api/v1/incidents/${incidentId}`).send({ severity: 'LOW' }).expect(401);
  });

  it('GET /incidents validates filters and passes the authenticated user', async () => {
    const list = vi.fn<IncidentService['list']>(async () => ({
      items: [incident],
      nextCursor: null,
      total: 1,
    }));
    const app = appWith({ list });
    const monitorId = randomUUID();
    const res = await app
      .get(`/api/v1/incidents?status=ACTIVE&severity=HIGH&monitorId=${monitorId}&limit=5`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(list).toHaveBeenCalledWith(userId, {
      status: 'ACTIVE',
      severity: 'HIGH',
      monitorId,
      limit: 5,
    });

    for (const bad of [
      'status=CLOSED',
      'severity=URGENT',
      'monitorId=nope',
      'limit=0',
      'limit=101',
    ]) {
      const r = await app.get(`/api/v1/incidents?${bad}`).set('Authorization', auth);
      expect(r.status, bad).toBe(400);
    }
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('GET /incidents/counts is not mistaken for an incident ID', async () => {
    const counts = vi.fn<IncidentService['counts']>(async () => ({
      total: 3,
      open: 1,
      acknowledged: 1,
      resolved: 1,
    }));
    const res = await appWith({ counts })
      .get('/api/v1/incidents/counts')
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.data).toEqual({ total: 3, open: 1, acknowledged: 1, resolved: 1 });
    expect(counts).toHaveBeenCalledWith(userId, undefined);
  });

  it('answers malformed IDs with the same 404 as unknown ones', async () => {
    const res = await appWith({})
      .get('/api/v1/incidents/not-a-uuid')
      .set('Authorization', auth)
      .expect(404);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('INCIDENT_NOT_FOUND');
  });

  it('POST /acknowledge returns the incident or the service conflict', async () => {
    const acknowledge = vi
      .fn<IncidentService['acknowledge']>()
      .mockResolvedValueOnce({ ...incident, status: 'ACKNOWLEDGED' })
      .mockRejectedValueOnce(new AppError(409, 'INCIDENT_ALREADY_ACKNOWLEDGED', 'already'));
    const app = appWith({ acknowledge });
    const ok = await app
      .post(`/api/v1/incidents/${incidentId}/acknowledge`)
      .set('Authorization', auth)
      .expect(200);
    expect(ok.body.data.status).toBe('ACKNOWLEDGED');
    const again = await app
      .post(`/api/v1/incidents/${incidentId}/acknowledge`)
      .set('Authorization', auth)
      .expect(409);
    expect(again.body.error.code).toBe('INCIDENT_ALREADY_ACKNOWLEDGED');
    expect(acknowledge).toHaveBeenCalledWith(userId, incidentId);
  });

  it('PATCH accepts only title, description and severity', async () => {
    const update = vi.fn<IncidentService['update']>(async () => incident);
    const app = appWith({ update });
    await app
      .patch(`/api/v1/incidents/${incidentId}`)
      .set('Authorization', auth)
      .send({ severity: 'CRITICAL', description: '  ' })
      .expect(200);
    expect(update).toHaveBeenCalledWith(userId, incidentId, {
      severity: 'CRITICAL',
      description: null,
    });

    for (const body of [
      {},
      { status: 'RESOLVED' },
      { resolvedAt: '2026-01-01T00:00:00Z' },
      { title: '' },
      { title: 'x'.repeat(201) },
    ]) {
      const r = await app
        .patch(`/api/v1/incidents/${incidentId}`)
        .set('Authorization', auth)
        .send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('GET /events validates paging', async () => {
    const events = vi.fn<IncidentService['events']>(async () => ({ items: [], nextCursor: null }));
    const app = appWith({ events });
    await app.get(`/api/v1/incidents/${incidentId}/events`).set('Authorization', auth).expect(200);
    expect(events).toHaveBeenCalledWith(userId, incidentId, { limit: 100 });
    await app
      .get(`/api/v1/incidents/${incidentId}/events?limit=500`)
      .set('Authorization', auth)
      .expect(400);
  });
});
