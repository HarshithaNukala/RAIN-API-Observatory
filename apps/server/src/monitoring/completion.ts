import {
  CHECK_ERROR_MESSAGE_MAX_LENGTH,
  HEALTH_NEUTRAL_REASONS,
  type MonitorCheckSource,
  type MonitorStatus,
} from '@rain/shared';
import type { MonitorRow, NewMonitorCheckRow } from '../db/schema.js';
import type { CheckExecution } from './executor.js';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  applyCheckOutcome,
  nextStatusChangedAt,
  type HealthThresholds,
  type HealthTransition,
} from './health.js';
import { nextScheduledCheckAt } from './schedule.js';

/**
 * Pure decisions for finishing (or abandoning) one claimed check. Both the PostgreSQL store and
 * the in-memory test store call these inside their "lock the monitor row" step, so the rules are
 * written and tested once.
 */

/** One claim of one monitor by one worker: an attempt. */
export interface ClaimedMonitor {
  /** The monitor as it was when claimed, including the lease just taken. */
  monitor: MonitorRow;
  /** Proves ownership of the lease; also the attempt ID recorded with the check. */
  leaseToken: string;
  /** Database time of the claim. */
  claimedAt: Date;
  /** The scheduled check was due when claimed (next_check_at <= claimedAt). */
  due: boolean;
  /** The queued manual request this attempt serves, if any. */
  manualRequestedAt: Date | null;
}

export const claimSource = (claim: ClaimedMonitor): MonitorCheckSource =>
  claim.manualRequestedAt ? 'MANUAL' : 'SCHEDULED';

/** The monitor fields completion reads, as they are now (locked), not as they were at claim. */
export type CompletionSnapshot = Pick<
  MonitorRow,
  | 'name'
  | 'ownerId'
  | 'enabled'
  | 'leaseToken'
  | 'currentStatus'
  | 'consecutiveFailures'
  | 'consecutiveSuccesses'
  | 'statusChangedAt'
  | 'nextCheckAt'
  | 'checkIntervalSeconds'
  | 'manualCheckRequestedAt'
  | 'lastManualCheckAt'
>;

/** Columns completion writes on `monitors`. The lease is always cleared. */
export interface MonitorCompletionUpdate {
  lastCheckedAt?: Date;
  currentStatus?: MonitorStatus;
  consecutiveFailures?: number;
  consecutiveSuccesses?: number;
  statusChangedAt?: Date | null;
  nextCheckAt: Date;
  manualCheckRequestedAt: Date | null;
  lastManualCheckAt: Date | null;
  leaseUntil: null;
  leaseToken: null;
}

export type DiscardReason = 'MONITOR_DELETED' | 'LEASE_LOST';
/** Why a recorded check did not change health. */
export type HealthSkipReason = 'PAUSED' | 'HEALTH_NEUTRAL';

export type CompletionPlan =
  | { kind: 'discard'; reason: DiscardReason }
  | {
      kind: 'record';
      check: NewMonitorCheckRow;
      update: MonitorCompletionUpdate;
      /** Set when health was evaluated; null when it was deliberately left alone. */
      transition: HealthTransition | null;
      healthSkipped: HealthSkipReason | null;
    };

/**
 * Lease check shared by completion and release. A stale worker (its lease expired and another
 * worker re-claimed the monitor, so the token changed) must never write anything.
 */
function leaseProblem(
  current: CompletionSnapshot | undefined,
  claim: ClaimedMonitor,
): DiscardReason | null {
  if (!current) return 'MONITOR_DELETED';
  if (current.leaseToken !== claim.leaseToken) return 'LEASE_LOST';
  return null;
}

/**
 * Next scheduled time after this attempt. Only a claim that was due advances the schedule, and only
 * if nobody rescheduled the monitor meanwhile (a resume sets next_check_at to now): manual checks
 * never shift the cadence.
 */
function scheduleAfter(current: CompletionSnapshot, claim: ClaimedMonitor, now: Date): Date {
  const untouched = current.nextCheckAt.getTime() === claim.monitor.nextCheckAt.getTime();
  if (!claim.due || !untouched || !current.enabled) return current.nextCheckAt;
  return nextScheduledCheckAt(claim.monitor.nextCheckAt, current.checkIntervalSeconds, now);
}

/** Clears the manual request only if it is the one this attempt served. */
function manualAfter(current: CompletionSnapshot, claim: ClaimedMonitor): Date | null {
  const served =
    claim.manualRequestedAt !== null &&
    current.manualCheckRequestedAt?.getTime() === claim.manualRequestedAt.getTime();
  return served ? null : current.manualCheckRequestedAt;
}

export function planCompletion(
  current: CompletionSnapshot | undefined,
  claim: ClaimedMonitor,
  execution: CheckExecution,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): CompletionPlan {
  const problem = leaseProblem(current, claim);
  if (problem || !current) return { kind: 'discard', reason: problem ?? 'MONITOR_DELETED' };

  const source = claimSource(claim);
  const { result } = execution;
  const check: NewMonitorCheckRow = {
    monitorId: claim.monitor.id,
    attemptId: claim.leaseToken,
    source,
    checkedAt: execution.checkedAt,
    outcome: result.outcome,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    failureReason: result.failureReason,
    errorMessage: execution.errorMessage?.slice(0, CHECK_ERROR_MESSAGE_MAX_LENGTH) ?? null,
  };

  const update: MonitorCompletionUpdate = {
    lastCheckedAt: execution.checkedAt,
    nextCheckAt: scheduleAfter(current, claim, now),
    manualCheckRequestedAt: manualAfter(current, claim),
    lastManualCheckAt: source === 'MANUAL' ? execution.checkedAt : current.lastManualCheckAt,
    leaseUntil: null,
    leaseToken: null,
  };

  // Paused during the check: the result is history, but health stays as the owner left it.
  // RAIN's own refusals (SSRF guard, configuration) say nothing about the target's health.
  const healthSkipped: HealthSkipReason | null = !current.enabled
    ? 'PAUSED'
    : result.failureReason && HEALTH_NEUTRAL_REASONS.has(result.failureReason)
      ? 'HEALTH_NEUTRAL'
      : null;
  if (healthSkipped) return { kind: 'record', check, update, transition: null, healthSkipped };

  const transition = applyCheckOutcome(
    {
      status: current.currentStatus as MonitorStatus,
      consecutiveFailures: current.consecutiveFailures,
      consecutiveSuccesses: current.consecutiveSuccesses,
    },
    result.outcome,
    thresholds,
  );
  return {
    kind: 'record',
    check,
    update: {
      ...update,
      currentStatus: transition.next.status,
      consecutiveFailures: transition.next.consecutiveFailures,
      consecutiveSuccesses: transition.next.consecutiveSuccesses,
      statusChangedAt: nextStatusChangedAt(
        transition,
        execution.checkedAt,
        current.statusChangedAt,
      ),
    },
    transition,
    healthSkipped: null,
  };
}

export type ReleasePlan =
  | { kind: 'discard'; reason: DiscardReason }
  | {
      kind: 'release';
      update: Pick<
        MonitorCompletionUpdate,
        'nextCheckAt' | 'manualCheckRequestedAt' | 'leaseUntil' | 'leaseToken'
      >;
    };

/**
 * Giving up an attempt without a result (an unexpected error, not a check outcome). The schedule
 * still advances and the manual request is dropped, so a persistent fault can't make the worker
 * spin on one monitor; health is untouched because nothing was observed.
 */
export function planRelease(
  current: CompletionSnapshot | undefined,
  claim: ClaimedMonitor,
  now: Date,
): ReleasePlan {
  const problem = leaseProblem(current, claim);
  if (problem || !current) return { kind: 'discard', reason: problem ?? 'MONITOR_DELETED' };
  return {
    kind: 'release',
    update: {
      nextCheckAt: scheduleAfter(current, claim, now),
      manualCheckRequestedAt: manualAfter(current, claim),
      leaseUntil: null,
      leaseToken: null,
    },
  };
}
