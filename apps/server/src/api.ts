import { createRemoteJWKSet } from 'jose';
import { createApp } from './app.js';
import { createTokenVerifier } from './auth/verify-token.js';
import { ConfigError, loadServerConfig, type ServerConfig } from './config.js';
import { createSecretBox } from './crypto/secret-box.js';
import { createDatabase } from './db/client.js';
import { createProfileStore } from './db/profiles.js';
import { loadDotEnv } from './env-file.js';
import { createLogger } from './logger.js';
import { createMonitorRepository } from './monitors/monitor-repository.js';
import { createMonitorService } from './monitors/monitor-service.js';

loadDotEnv();

let config: ServerConfig;
try {
  config = loadServerConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[api] ${err.message}\nSee .env.example for the required variables.`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({
  service: 'api',
  level: config.logLevel,
  pretty: config.env === 'development',
});
const database = createDatabase(config.databaseUrl);
const jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000,
});

const profiles = createProfileStore(database.db);

const app = createApp({
  logger,
  corsOrigins: config.corsOrigins,
  trustProxy: config.trustProxy,
  verifyAccessToken: createTokenVerifier({
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    jwks,
    legacyHs256Secret: config.auth.legacyHs256Secret,
  }),
  profiles,
  monitors: createMonitorService({
    repository: createMonitorRepository(database.db),
    profiles,
    secretBox: createSecretBox(config.encryption),
    maxMonitorsPerUser: config.maxMonitorsPerUser,
  }),
  readiness: async () => {
    const [db, auth] = await Promise.allSettled([
      database.ping(),
      // Signing keys must be fetchable for asymmetric tokens; reuse the cache when fresh.
      jwks.fresh ? Promise.resolve() : jwks.reload(),
    ]);
    if (db.status === 'rejected')
      logger.warn({ err: db.reason }, 'readiness: database unavailable');
    if (auth.status === 'rejected')
      logger.warn({ err: auth.reason }, 'readiness: JWKS unavailable');
    return {
      database: db.status === 'fulfilled' ? 'ok' : 'error',
      auth: auth.status === 'fulfilled' ? 'ok' : 'error',
    };
  },
});

const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    logger.fatal({ err }, 'api failed to start');
    process.exit(1);
  }
  logger.info(
    { port: config.port, env: config.env, legacyHs256: Boolean(config.auth.legacyHs256Secret) },
    'api listening',
  );
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'api shutting down');
  const force = setTimeout(() => {
    logger.error('api shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    void database.close().finally(() => {
      logger.info('api stopped');
      clearTimeout(force);
    });
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
