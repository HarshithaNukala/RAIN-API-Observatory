import { stubStatusPageService } from '../test-support/status-page-service-stub.js';
import { randomUUID } from 'node:crypto';
import { ApiErrorSchema, type NotificationSettings } from '@rain/shared';
import { pino } from 'pino';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { stubAnalyticsService } from '../test-support/analytics-service-stub.js';
import { client } from '../test-support/http.js';
import { stubIncidentService } from '../test-support/incident-service-stub.js';
import { stubMonitorService } from '../test-support/monitor-service-stub.js';
import { stubNotificationService } from '../test-support/notification-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from '../test-support/tokens.js';
import type { NotificationService } from './notification-service.js';

const userId = randomUUID();
const monitorId = randomUUID();
let auth: string;
let signer: Awaited<ReturnType<typeof createTestSigner>>;

beforeAll(async () => {
  signer = await createTestSigner();
  auth = `Bearer ${await signer.sign({ sub: userId, email: 'owner@example.com' })}`;
});

function appWith(notifications: Partial<NotificationService>) {
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
      analytics: stubAnalyticsService(),
      notifications: stubNotificationService(notifications),
      statusPages: stubStatusPageService(),
      readiness: async () => ({ database: 'ok', auth: 'ok' }),
    }),
  );
}

const settings: NotificationSettings = {
  monitorId,
  email: { enabled: true, address: 'owner@example.com', providerConfigured: false },
  webhook: null,
};
const settingsPath = `/api/v1/monitors/${monitorId}/notifications`;

describe('notification routes', () => {
  it('require authentication', async () => {
    const app = appWith({});
    await app.get(settingsPath).expect(401);
    await app.put(settingsPath).send({ emailEnabled: true }).expect(401);
    await app.get('/api/v1/notifications').expect(401);
    await app.get(`/api/v1/notifications/${randomUUID()}`).expect(401);
    await app.post(`/api/v1/notifications/${randomUUID()}/retry`).expect(401);
  });

  it('pass the user and their token email to the settings service', async () => {
    const getSettings = vi.fn<NotificationService['getSettings']>(async () => settings);
    const updateSettings = vi.fn<NotificationService['updateSettings']>(async () => ({
      settings,
      signingSecret: null,
    }));
    const app = appWith({ getSettings, updateSettings });
    await app.get(settingsPath).set('Authorization', auth).expect(200);
    expect(getSettings).toHaveBeenCalledWith(userId, 'owner@example.com', monitorId);
    await app
      .put(settingsPath)
      .set('Authorization', auth)
      .send({
        emailEnabled: true,
        webhook: { enabled: true, url: 'https://hooks.example.com/rain' },
      })
      .expect(200);
    expect(updateSettings).toHaveBeenCalledWith(userId, 'owner@example.com', monitorId, {
      emailEnabled: true,
      webhook: { enabled: true, url: 'https://hooks.example.com/rain' },
    });
  });

  it.each([
    ['a private IP literal', { webhook: { enabled: true, url: 'http://169.254.169.254/latest' } }],
    ['localhost', { webhook: { enabled: true, url: 'http://localhost/hook' } }],
    [
      'a non-standard port',
      { webhook: { enabled: true, url: 'https://hooks.example.com:8443/x' } },
    ],
    [
      'credentials in the URL',
      { webhook: { enabled: true, url: 'https://u:p@hooks.example.com/x' } },
    ],
    [
      'a forged signature header',
      {
        webhook: {
          enabled: true,
          url: 'https://hooks.example.com/x',
          header: { name: 'X-Rain-Signature', value: 'v1=0' },
        },
      },
    ],
    [
      'a header with a line break',
      {
        webhook: {
          enabled: true,
          url: 'https://hooks.example.com/x',
          header: { name: 'X-Key', value: 'a\r\nb' },
        },
      },
    ],
    ['unknown fields', { emailEnabled: true, webhookSecret: 'mine' }],
    ['an empty update', {}],
  ])('reject %s with 400', async (_label, body) => {
    const updateSettings = vi.fn<NotificationService['updateSettings']>();
    const res = await appWith({ updateSettings })
      .put(settingsPath)
      .set('Authorization', auth)
      .send(body);
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(res.body).error.code).toMatch(/VALIDATION_ERROR|UNSUPPORTED_PORT/);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('validate list filters and answer malformed IDs with 404', async () => {
    const list = vi.fn<NotificationService['list']>(async () => ({
      items: [],
      nextCursor: null,
      total: 0,
    }));
    const app = appWith({ list });
    await app
      .get('/api/v1/notifications?status=FAILED&channel=WEBHOOK')
      .set('Authorization', auth)
      .expect(200);
    expect(list).toHaveBeenCalledWith(userId, { status: 'FAILED', channel: 'WEBHOOK', limit: 25 });
    for (const bad of ['status=LOST', 'channel=SMS', 'limit=0', 'monitorId=x']) {
      expect(
        (await app.get(`/api/v1/notifications?${bad}`).set('Authorization', auth)).status,
        bad,
      ).toBe(400);
    }
    const res = await app.get('/api/v1/notifications/nope').set('Authorization', auth).expect(404);
    expect(ApiErrorSchema.parse(res.body).error.code).toBe('NOTIFICATION_NOT_FOUND');
    await app.get('/api/v1/monitors/nope/notifications').set('Authorization', auth).expect(404);
  });
});
