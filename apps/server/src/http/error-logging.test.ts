import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { CreateStatusPageSchema, StatusPageDisplayNameSchema } from '@rain/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { createLogger } from '../logger.js';
import { safeError } from '../safe-error.js';
import { stubAnalyticsService } from '../test-support/analytics-service-stub.js';
import { client } from '../test-support/http.js';
import { stubIncidentService } from '../test-support/incident-service-stub.js';
import { stubMonitorService } from '../test-support/monitor-service-stub.js';
import { stubNotificationService } from '../test-support/notification-service-stub.js';
import { stubStatusPageService } from '../test-support/status-page-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from '../test-support/tokens.js';

// Phase 8 security fixes: database errors must not leak SQL parameters into logs, and public
// status-page text must not contain bidirectional override characters.

function driverError() {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
    code: '23505',
  });
  return new Error(
    'Failed query: insert into "monitors" ("url", "name") values ($1, $2)\nparams: https://api.example.com/?k=leaked-param-value,owner@example.com',
    { cause: driver },
  );
}

describe('error logging', () => {
  it('logs a database failure by driver code and message only, never the SQL parameters', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'api',
      level: 'debug',
      destination: new Writable({
        write(chunk: Buffer, _enc, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    });
    const signer = await createTestSigner();
    const auth = `Bearer ${await signer.sign({ sub: randomUUID() })}`;
    const app = client(
      createApp({
        logger,
        corsOrigins: [],
        trustProxy: 0,
        verifyAccessToken: createTokenVerifier({
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
          jwks: signer.jwks,
        }),
        profiles: { ensure: () => Promise.reject(new Error('unused')) },
        monitors: stubMonitorService({ list: () => Promise.reject(driverError()) }),
        incidents: stubIncidentService(),
        analytics: stubAnalyticsService(),
        notifications: stubNotificationService(),
        statusPages: stubStatusPageService(),
        readiness: async () => ({ database: 'ok', auth: 'ok' }),
      }),
    );

    const res = await app.get('/api/v1/monitors').set('Authorization', auth).expect(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/params|leaked|insert into/);

    const log = lines.join('\n');
    expect(log).toContain('Internal server error');
    expect(log).toContain('23505');
    expect(log).not.toContain('leaked-param-value');
    expect(log).not.toContain('owner@example.com');
    expect(log).not.toContain('Failed query');
  });

  it('summarises wrapped driver errors safely', () => {
    expect(safeError(driverError())).toEqual({
      name: 'Error',
      code: '23505',
      message: 'duplicate key value violates unique constraint "x"',
    });
  });
});

describe('public status-page text', () => {
  it.each([0x202e, 0x202a, 0x2066, 0x2069].map((cp) => String.fromCodePoint(cp)))(
    'rejects bidirectional control %#',
    (ch) => {
      expect(CreateStatusPageSchema.safeParse({ title: `Acme${ch}gnp.exe` }).success).toBe(false);
      expect(
        CreateStatusPageSchema.safeParse({ title: 'Acme', description: `ok${ch}` }).success,
      ).toBe(false);
      expect(StatusPageDisplayNameSchema.safeParse(`API${ch}`).success).toBe(false);
    },
  );

  it('still accepts ordinary international text', () => {
    expect(
      CreateStatusPageSchema.safeParse({
        title: 'Statut — Café Ünïcode 日本語',
        description: 'Line one\nLine two',
      }).success,
    ).toBe(true);
  });
});
