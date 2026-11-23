import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { createApp } from '../../apps/server/src/app.js';
import { createTokenVerifier } from '../../apps/server/src/auth/verify-token.js';
import { createSecretBox, type SecretBox } from '../../apps/server/src/crypto/secret-box.js';
import { createDatabase } from '../../apps/server/src/db/client.js';
import { createProfileStore } from '../../apps/server/src/db/profiles.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { createMonitorRepository } from '../../apps/server/src/monitors/monitor-repository.js';
import { createMonitorService } from '../../apps/server/src/monitors/monitor-service.js';
import { createAnalyticsRepository } from '../../apps/server/src/analytics/analytics-repository.js';
import { createAnalyticsService } from '../../apps/server/src/analytics/analytics-service.js';
import { createNotificationRepository } from '../../apps/server/src/notifications/notification-repository.js';
import { createNotificationService } from '../../apps/server/src/notifications/notification-service.js';
import { createStatusPageRepository } from '../../apps/server/src/status-pages/status-page-repository.js';
import { createStatusPageService } from '../../apps/server/src/status-pages/status-page-service.js';
import { createIncidentRepository } from '../../apps/server/src/incidents/incident-repository.js';
import { createIncidentService } from '../../apps/server/src/incidents/incident-service.js';
import { client } from '../../apps/server/src/test-support/http.js';
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  createTestSigner,
} from '../../apps/server/src/test-support/tokens.js';

export interface HarnessOptions {
  maxMonitorsPerUser?: number;
  /** Wrap the real SecretBox, e.g. to inject a failure mid-transaction. */
  wrapSecretBox?: (box: SecretBox) => SecretBox;
}

/**
 * The real Express app, service, repository and encryption, on the disposable test database.
 * Only the token issuer is local: tokens are genuinely signed and verified, just not by Supabase.
 */
export async function createHarness(options: HarnessOptions = {}) {
  const database = createDatabase(inject('databaseUrl'), { maxConnections: 8 });
  const signer = await createTestSigner();
  const realBox = createSecretBox({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
  const secretBox = options.wrapSecretBox?.(realBox) ?? realBox;
  const profiles = createProfileStore(database.db);
  const monitors = createMonitorService({
    repository: createMonitorRepository(database.db),
    profiles,
    secretBox,
    maxMonitorsPerUser: options.maxMonitorsPerUser ?? 25,
  });

  const logLines: string[] = [];
  const logger = createLogger({
    service: 'api',
    level: 'debug',
    destination: new Writable({
      write(chunk: Buffer, _encoding, done) {
        logLines.push(chunk.toString());
        done();
      },
    }),
  });

  const app = createApp({
    logger,
    corsOrigins: [],
    trustProxy: 0,
    verifyAccessToken: createTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: signer.jwks,
    }),
    profiles,
    monitors,
    incidents: createIncidentService({ repository: createIncidentRepository(database.db) }),
    analytics: createAnalyticsService({ repository: createAnalyticsRepository(database.db) }),
    statusPages: createStatusPageService({
      repository: createStatusPageRepository(database.db),
      profiles,
    }),
    publicRateLimitPerMinute: 100_000,
    notifications: createNotificationService({
      repository: createNotificationRepository(database.db),
      secretBox,
      emailConfigured: false,
    }),
    readiness: async () => {
      await database.ping();
      return { database: 'ok', auth: 'ok' };
    },
    rateLimitPerMinute: 100_000,
  });

  /** A row in the stubbed auth.users plus a signed access token for it. */
  async function createUser() {
    const id = randomUUID();
    // The same address in auth.users and the token (notifications read it from auth.users).
    const email = `${id.slice(0, 8)}@example.com`;
    await database.db.execute(sql`insert into auth.users (id, email) values (${id}, ${email})`);
    const auth = `Bearer ${await signer.sign({ sub: id, email })}`;
    const http = client(app);
    return {
      id,
      get: (path: string) => http.get(path).set('Authorization', auth),
      post: (path: string, body?: object) => http.post(path).set('Authorization', auth).send(body),
      patch: (path: string, body: object) => http.patch(path).set('Authorization', auth).send(body),
      put: (path: string, body: object) => http.put(path).set('Authorization', auth).send(body),
      delete: (path: string) => http.delete(path).set('Authorization', auth),
    };
  }

  return {
    app,
    db: database.db,
    /** Decrypts with the real key, for asserting what was stored. */
    secretBox: realBox,
    logLines,
    createUser,
    anonymous: client(app),
    close: () => database.close(),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
export type TestUser = Awaited<ReturnType<Harness['createUser']>>;

/** SQLSTATE of a failed statement; Drizzle wraps the driver error in `cause`. */
export function sqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}
