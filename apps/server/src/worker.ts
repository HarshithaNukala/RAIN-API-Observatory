import { ConfigError, loadWorkerConfig, type WorkerConfig } from './config.js';
import { createSecretBox } from './crypto/secret-box.js';
import { createDatabase } from './db/client.js';
import { loadDotEnv } from './env-file.js';
import { createLogger } from './logger.js';
import { createMonitorExecutor, createProductionTransport } from './monitoring/executor.js';
import { createMonitoringStore } from './monitoring/monitoring-store.js';
import { createMonitoringWorker } from './monitoring/worker-engine.js';
import { createDispatchStore } from './notifications/dispatch-store.js';
import { UNCONFIGURED_EMAIL_PROVIDER, createResendProvider } from './notifications/email.js';
import { createNotificationDispatcher } from './notifications/notification-dispatcher.js';
import { createWebhookSender } from './notifications/webhook-sender.js';

/**
 * The monitoring worker process, separate from the API. Any number of instances can run against
 * one database: claims use FOR UPDATE SKIP LOCKED and leases, so they never check the same monitor
 * at the same time.
 */

loadDotEnv();

let config: WorkerConfig;
try {
  config = loadWorkerConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[worker] ${err.message}\nSee .env.example for the required variables.`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({
  service: 'worker',
  level: config.logLevel,
  pretty: config.env === 'development',
});

// Fail closed: without the SSRF-safe transport the worker must not run at all, in any environment.
const transport = createProductionTransport();
if (transport.kind !== 'dispatcher') {
  logger.fatal({ reason: transport.reason }, 'worker cannot start without the SSRF-safe transport');
  process.exit(1);
}
const dispatcher = transport.dispatcher;

const database = createDatabase(config.databaseUrl, {
  maxConnections: config.worker.dbMaxConnections,
});
const secretBox = createSecretBox(config.encryption);
const worker = createMonitoringWorker({
  store: createMonitoringStore(database.db),
  executor: createMonitorExecutor({ transport, secretBox }),
  logger,
  settings: config.worker,
});

// Notifications run in the same process but on their own loop and concurrency, so slow
// deliveries never delay checks. Webhooks share the SSRF-safe transport with the executor.
const notifications = createNotificationDispatcher({
  store: createDispatchStore(database.db),
  email: config.email.resend
    ? createResendProvider(config.email.resend)
    : UNCONFIGURED_EMAIL_PROVIDER,
  webhook: createWebhookSender({ transport }),
  secretBox,
  logger: logger.child({ component: 'notifications' }),
  appBaseUrl: config.appBaseUrl,
  settings: config.dispatcher,
});
if (!config.email.resend) {
  logger.warn(
    'email is not configured (RESEND_API_KEY, NOTIFICATION_EMAIL_FROM): email notifications will fail',
  );
}

worker.start();
notifications.start();
logger.info({ env: config.env, pid: process.pid }, 'worker started');

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(
    { signal, inFlight: worker.inFlight, notificationsInFlight: notifications.inFlight },
    'worker shutting down',
  );
  const [checks, deliveries] = await Promise.all([
    worker.stop(config.worker.shutdownGraceMs),
    notifications.stop(config.worker.shutdownGraceMs),
  ]);
  const drained = checks.drained && deliveries.drained;
  if (!drained) {
    // Their leases expire and another worker picks them up; nothing is half-written.
    logger.warn(
      { abandonedChecks: checks.abandoned, abandonedDeliveries: deliveries.abandoned },
      'grace period over; abandoning in-flight work',
    );
  }
  try {
    await database.close();
    await dispatcher.close();
  } catch (err) {
    logger.warn({ err: { message: (err as Error).message } }, 'error while closing connections');
  }
  logger.info('worker stopped');
  process.exit(drained ? 0 : 1);
}

process.on('SIGTERM', (s) => void shutdown(s));
process.on('SIGINT', (s) => void shutdown(s));
