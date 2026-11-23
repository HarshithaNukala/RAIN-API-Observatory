import type { Logger } from 'pino';
import { safeError } from '../safe-error.js';
import { claimSource, type ClaimedMonitor } from './completion.js';
import {
  ExecutionRefusedError,
  EXECUTOR_LIMITS,
  executableMonitorFrom,
  refusedExecution,
  type CheckExecution,
  type MonitorExecutor,
} from './executor.js';
import type { CompletionResult, MonitoringStore } from './monitoring-store.js';

/**
 * The monitoring worker loop:
 *
 *   poll → claim (SKIP LOCKED, leased) → load headers → execute (no transaction open)
 *        → complete (short transaction, lease-token guarded) → next poll
 *
 * Crash semantics: the only durable state is in PostgreSQL. If a worker dies mid-check its lease
 * simply expires and another worker re-claims the monitor (the schedule and any manual request are
 * still pending). A check can therefore be *executed* more than once, but each attempt is *recorded*
 * at most once (attempt_id is unique) and a stale attempt never writes (lease token mismatch).
 */

export interface WorkerSettings {
  /** Checks running at once in this process. */
  concurrency: number;
  /** Time between polls when idle. */
  pollIntervalMs: number;
  /** How long a claim is valid. Must exceed the longest timeout plus a safety margin. */
  leaseSeconds: number;
  /** Ceiling for the backoff after database errors. */
  maxBackoffMs: number;
}

export const DEFAULT_WORKER_SETTINGS: WorkerSettings = {
  concurrency: 25,
  pollIntervalMs: 1000,
  leaseSeconds: 90,
  maxBackoffMs: 30_000,
};

/** Margin between the longest possible request and the lease expiry. */
export const LEASE_MARGIN_SECONDS = 15;
export const MIN_LEASE_SECONDS = EXECUTOR_LIMITS.timeoutMs.max / 1000 + LEASE_MARGIN_SECONDS;

export function validateWorkerSettings(settings: WorkerSettings): string[] {
  const problems: string[] = [];
  const int = (name: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max}`);
    }
  };
  int('concurrency', settings.concurrency, 1, 500);
  int('pollIntervalMs', settings.pollIntervalMs, 100, 60_000);
  int('leaseSeconds', settings.leaseSeconds, MIN_LEASE_SECONDS, 3600);
  int('maxBackoffMs', settings.maxBackoffMs, settings.pollIntervalMs, 600_000);
  return problems;
}

export interface MonitoringWorkerDependencies {
  store: MonitoringStore;
  executor: MonitorExecutor;
  logger: Logger;
  settings?: Partial<WorkerSettings>;
  now?: () => Date;
}

export interface StopResult {
  /** All in-flight checks finished within the grace period. */
  drained: boolean;
  /** Checks still running when the grace period ended; their leases will expire. */
  abandoned: number;
}

export interface MonitoringWorker {
  /** Starts the polling loop. */
  start(): void;
  /** Stops claiming, then waits up to `graceMs` for in-flight checks to complete. */
  stop(graceMs: number): Promise<StopResult>;
  /** One poll without the loop: claims up to free capacity and resolves when those checks finish. */
  pollOnce(): Promise<number>;
  readonly inFlight: number;
}

/** Re-exported for existing importers; the implementation lives in ../safe-error.ts. */
export { safeError } from '../safe-error.js';
export function createMonitoringWorker(deps: MonitoringWorkerDependencies): MonitoringWorker {
  const settings = { ...DEFAULT_WORKER_SETTINGS, ...deps.settings };
  const problems = validateWorkerSettings(settings);
  if (problems.length > 0) throw new RangeError(`Invalid worker settings: ${problems.join('; ')}`);
  const { store, executor, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const active = new Set<Promise<void>>();
  let running = false;
  let stopping = false;
  let loopDone: Promise<void> = Promise.resolve();
  let wake: (() => void) | null = null;
  let consecutiveErrors = 0;

  async function execute(claim: ClaimedMonitor): Promise<CheckExecution> {
    const headers = await store.loadHeaders(claim.monitor.id);
    const monitor = executableMonitorFrom(claim.monitor, headers);
    try {
      return await executor.execute(monitor);
    } catch (err) {
      // Configuration refusals become a recorded, health-neutral check the owner can see.
      // OUTBOUND_DISABLED is a deployment fault, not a monitor problem: nothing is recorded.
      if (err instanceof ExecutionRefusedError && err.code !== 'OUTBOUND_DISABLED') {
        return refusedExecution(monitor, err, now());
      }
      throw err;
    }
  }

  async function runCheck(claim: ClaimedMonitor): Promise<void> {
    const log = logger.child({
      monitorId: claim.monitor.id,
      attemptId: claim.leaseToken,
      source: claimSource(claim),
    });
    let result: CompletionResult;
    try {
      const execution = await execute(claim);
      result = await store.complete(claim, execution);
      if (!result.recorded) {
        log.warn({ reason: result.reason }, 'check result discarded');
        return;
      }
      log.info(
        {
          outcome: execution.result.outcome,
          statusCode: execution.result.statusCode,
          latencyMs: execution.result.latencyMs,
          failureReason: execution.result.failureReason,
          status: result.status,
          statusChanged: result.statusChanged,
          healthSkipped: result.healthSkipped,
          incident: result.incident,
        },
        'check recorded',
      );
    } catch (err) {
      log.error({ error: safeError(err) }, 'check failed unexpectedly; releasing the lease');
      try {
        await store.release(claim);
      } catch (releaseErr) {
        log.warn({ error: safeError(releaseErr) }, 'lease release failed; the lease will expire');
      }
    }
  }

  /** Claims up to free capacity and starts each check. Returns the started checks. */
  async function claimAndStart(): Promise<Array<Promise<void>>> {
    const free = settings.concurrency - active.size;
    if (free <= 0) return [];
    const claims = await store.claim(free, settings.leaseSeconds);
    return claims.map((claim) => {
      const task = runCheck(claim).finally(() => {
        active.delete(task);
        wake?.(); // A slot freed up: poll again without waiting out the interval.
      });
      active.add(task);
      return task;
    });
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      let delay = settings.pollIntervalMs;
      try {
        const requested = settings.concurrency - active.size;
        const started = await claimAndStart();
        if (consecutiveErrors > 0) logger.info('database reachable again; polling resumed');
        consecutiveErrors = 0;
        // A full batch means more work may be waiting: poll again as soon as a slot is free.
        if (requested > 0 && started.length === requested) delay = settings.pollIntervalMs / 10;
      } catch (err) {
        consecutiveErrors++;
        delay = Math.min(settings.maxBackoffMs, settings.pollIntervalMs * 2 ** consecutiveErrors);
        logger.warn(
          { error: safeError(err), retryInMs: delay, consecutiveErrors },
          'claiming checks failed',
        );
      }
      if (!stopping) await pause(delay);
    }
  }

  return {
    get inFlight() {
      return active.size;
    },

    start() {
      if (running) return;
      running = true;
      logger.info({ ...settings }, 'monitoring worker polling');
      loopDone = loop();
    },

    async stop(graceMs) {
      stopping = true;
      wake?.();
      await loopDone;
      if (active.size === 0) return { drained: true, abandoned: 0 };
      logger.info({ inFlight: active.size, graceMs }, 'waiting for in-flight checks');
      let timer: NodeJS.Timeout | undefined;
      const graceOver = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), graceMs);
      });
      const outcome = await Promise.race([Promise.allSettled([...active]), graceOver]);
      clearTimeout(timer);
      return outcome === 'timeout'
        ? { drained: false, abandoned: active.size }
        : { drained: true, abandoned: 0 };
    },

    async pollOnce() {
      const started = await claimAndStart();
      await Promise.allSettled(started);
      return started.length;
    },
  };
}
