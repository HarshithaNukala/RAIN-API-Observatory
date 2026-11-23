import { stubStatusPageService } from '../test-support/status-page-service-stub.js';
import { stubNotificationService } from '../test-support/notification-service-stub.js';
import { randomUUID } from 'node:crypto';
import { ApiErrorSchema } from '@rain/shared';
import { pino } from 'pino';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { monitorNotFound } from '../monitors/monitor-service.js';
import { stubAnalyticsService } from '../test-support/analytics-service-stub.js';
import { client } from '../test-support/http.js';
import { stubIncidentService } from '../test-support/incident-service-stub.js';
import { stubMonitorService } from '../test-support/monitor-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from '../test-support/tokens.js';
import type { AnalyticsService } from './analytics-service.js';

const userId = randomUUID();
const monitorId = randomUUID();
let auth: string;
let signer: Awaited<ReturnType<typeof createTestSigner>>;

beforeAll(async () => {
  signer = await createTestSigner();
  auth = `Bearer ${await signer.sign({ sub: userId })}`;
});

function appWith(analytics: Partial<AnalyticsService>) {
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
      incidents: stubIncidentService(),
      analytics: stubAnalyticsService(analytics),
      notifications: stubNotificationService(),
      statusPages: stubStatusPageService(),
      readiness: async () => ({ database: 'ok', auth: 'ok' }),
    }),
  );
}

describe('analytics routes', () => {
  it('require authentication', async () => {
    const app = appWith({});
    await app.get('/api/v1/analytics/overview').expect(401);
    await app.get(`/api/v1/monitors/${monitorId}/metrics`).expect(401);
  });

  it('default the range to 24h and pass the authenticated user', async () => {
    const overview = vi.fn<AnalyticsService['overview']>(async () => ({}) as never);
    const monitorMetrics = vi.fn<AnalyticsService['monitorMetrics']>(async () => ({}) as never);
    const app = appWith({ overview, monitorMetrics });
    await app.get('/api/v1/analytics/overview').set('Authorization', auth).expect(200);
    await app
      .get(`/api/v1/monitors/${monitorId.toUpperCase()}/metrics?range=30d`)
      .set('Authorization', auth)
      .expect(200);
    expect(overview).toHaveBeenCalledWith(userId, '24h');
    expect(monitorMetrics).toHaveBeenCalledWith(userId, monitorId, '30d');
  });

  it.each(['1h', '90d', 'all', ''])('reject range=%s with 400', async (range) => {
    const overview = vi.fn<AnalyticsService['overview']>();
    const res = await appWith({ overview })
      .get(`/api/v1/analytics/overview?range=${range}`)
      .set('Authorization', auth);
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    expect(overview).not.toHaveBeenCalled();
  });

  it('answer malformed and foreign monitor IDs with the same 404', async () => {
    const monitorMetrics = vi.fn<AnalyticsService['monitorMetrics']>(async () => {
      throw monitorNotFound();
    });
    const app = appWith({ monitorMetrics });
    for (const id of ['nope', monitorId]) {
      const res = await app
        .get(`/api/v1/monitors/${id}/metrics`)
        .set('Authorization', auth)
        .expect(404);
      expect(ApiErrorSchema.parse(res.body).error.code).toBe('MONITOR_NOT_FOUND');
    }
    expect(monitorMetrics).toHaveBeenCalledTimes(1);
  });
});
