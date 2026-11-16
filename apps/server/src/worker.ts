import { ConfigError, loadWorkerConfig, type WorkerConfig } from './config.js';
import { loadDotEnv } from './env-file.js';
import { createLogger } from './logger.js';

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

// Scheduling and health-check execution arrive with the monitoring-engine phase.
// Until then the worker only proves it can boot, stay alive and stop cleanly.
const startedAt = Date.now();
const heartbeat = setInterval(() => {
  logger.debug({ uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }, 'worker heartbeat');
}, 60_000);

logger.info({ env: config.env, pid: process.pid }, 'worker started');

let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker shutting down');
  clearInterval(heartbeat);
  logger.info('worker stopped');
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
