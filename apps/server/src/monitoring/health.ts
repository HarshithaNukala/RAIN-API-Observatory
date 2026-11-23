import {
  HEALTH_THRESHOLDS,
  type CheckFailureReason,
  type MonitorCheckOutcome,
  type MonitorStatus,
  type NoResponseReason,
} from '@rain/shared';

/**
 * Pure health logic for the monitoring engine: no I/O, no clock, no database. The executor (a
 * later phase) turns an HTTP attempt into an `Observation`; these functions decide what it means.
 */

/** What the executor saw: either an HTTP response, or no response at all. */
export type Observation =
  | { kind: 'response'; statusCode: number; latencyMs: number }
  | { kind: 'no-response'; reason: NoResponseReason };

/** The pass/fail rules a check is judged against: the monitor's own configuration. */
export interface CheckCriteria {
  expectedStatusCode: number;
  latencyThresholdMs: number;
}

/** A classified check, shaped like a `monitor_checks` row (minus identity and timestamps). */
export interface CheckResult {
  outcome: MonitorCheckOutcome;
  /** NULL when no HTTP response was received. */
  statusCode: number | null;
  /** NULL exactly when no HTTP response was received; never a made-up value. */
  latencyMs: number | null;
  failureReason: CheckFailureReason | null;
}

export class InvalidObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidObservationError';
  }
}

/**
 * Classifies one check:
 * - wrong status code → FAILURE (`UNEXPECTED_STATUS`), keeping the status and latency;
 * - expected status, latency above the threshold → DEGRADED;
 * - expected status within the threshold → SUCCESS;
 * - no response → FAILURE with the reason, and NULL status and latency.
 */
export function classifyCheck(observation: Observation, criteria: CheckCriteria): CheckResult {
  if (observation.kind === 'no-response') {
    return {
      outcome: 'FAILURE',
      statusCode: null,
      latencyMs: null,
      failureReason: observation.reason,
    };
  }

  const { statusCode, latencyMs } = observation;
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new InvalidObservationError(`Invalid HTTP status code: ${statusCode}`);
  }
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new InvalidObservationError(`Invalid latency: ${latencyMs}`);
  }
  // Stored as whole milliseconds.
  const latency = Math.round(latencyMs);

  if (statusCode !== criteria.expectedStatusCode) {
    return {
      outcome: 'FAILURE',
      statusCode,
      latencyMs: latency,
      failureReason: 'UNEXPECTED_STATUS',
    };
  }
  return {
    outcome: latency > criteria.latencyThresholdMs ? 'DEGRADED' : 'SUCCESS',
    statusCode,
    latencyMs: latency,
    failureReason: null,
  };
}

/** The health fields a monitor carries between checks (columns on `monitors`). */
export interface HealthState {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export interface HealthThresholds {
  /** Consecutive failures that mark a monitor DOWN. */
  failure: number;
  /** Consecutive passing checks needed to leave DOWN. */
  recovery: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = HEALTH_THRESHOLDS;

export const INITIAL_HEALTH_STATE: HealthState = {
  status: 'UNKNOWN',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
};

export interface HealthTransition {
  previous: HealthState;
  next: HealthState;
  /** True when `next.status` differs from `previous.status`. */
  statusChanged: boolean;
}

/** A passing check is any check that got the expected response, fast or slow. */
export const isPassing = (outcome: MonitorCheckOutcome) => outcome !== 'FAILURE';

/** Consecutive failures after this outcome: one more on failure, reset by any passing check. */
export function nextConsecutiveFailures(current: number, outcome: MonitorCheckOutcome): number {
  return isPassing(outcome) ? 0 : current + 1;
}

/** Consecutive passing checks after this outcome: one more on pass, reset by any failure. */
export function nextConsecutiveSuccesses(current: number, outcome: MonitorCheckOutcome): number {
  return isPassing(outcome) ? current + 1 : 0;
}

function assertThresholds({ failure, recovery }: HealthThresholds): void {
  for (const [name, value] of [
    ['failure', failure],
    ['recovery', recovery],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} threshold must be a positive integer, got ${value}`);
    }
  }
  // The stored state can only tell that a monitor is recovering while it is still DOWN, i.e. on
  // the first passing check. Longer recoveries would need a persisted "recovering" flag.
  if (recovery > 2) {
    throw new RangeError(`recovery threshold must be 1 or 2, got ${recovery}`);
  }
}

/**
 * Applies one check outcome to a monitor's health (defaults: failure 2, recovery 2):
 *
 * - **Failure**: below the failure threshold the monitor is DEGRADED (with the defaults: the first
 *   consecutive failure); at the threshold and beyond it is DOWN. Any failure resets the
 *   consecutive-success count, including one during recovery.
 * - **Passing check (expected status, SUCCESS or DEGRADED) while DOWN**: the monitor becomes
 *   DEGRADED until the recovery threshold is met; at the threshold it follows the latest check
 *   (SUCCESS → HEALTHY, DEGRADED → DEGRADED). With the defaults: first passing check → DEGRADED,
 *   second → HEALTHY or DEGRADED by latency.
 * - **Passing check otherwise** (UNKNOWN, HEALTHY, DEGRADED): the status follows the latest check
 *   immediately.
 */
export function applyCheckOutcome(
  state: HealthState,
  outcome: MonitorCheckOutcome,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthTransition {
  assertThresholds(thresholds);
  const consecutiveFailures = nextConsecutiveFailures(state.consecutiveFailures, outcome);
  const consecutiveSuccesses = nextConsecutiveSuccesses(state.consecutiveSuccesses, outcome);

  let status: MonitorStatus;
  if (!isPassing(outcome)) {
    status = consecutiveFailures >= thresholds.failure ? 'DOWN' : 'DEGRADED';
  } else if (state.status === 'DOWN' && consecutiveSuccesses < thresholds.recovery) {
    status = 'DEGRADED';
  } else {
    status = outcome === 'SUCCESS' ? 'HEALTHY' : 'DEGRADED';
  }

  const next = { status, consecutiveFailures, consecutiveSuccesses };
  return { previous: state, next, statusChanged: status !== state.status };
}

/**
 * The value to store in `monitors.status_changed_at` after a check: the check time when the
 * status changed, otherwise the stored value unchanged.
 */
export function nextStatusChangedAt(
  transition: HealthTransition,
  checkedAt: Date,
  current: Date | null,
): Date | null {
  return transition.statusChanged ? checkedAt : current;
}

/** Classifies an observation and applies it, the usual single step for one executed check. */
export function evaluateCheck(
  state: HealthState,
  observation: Observation,
  criteria: CheckCriteria,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): { result: CheckResult; transition: HealthTransition } {
  const result = classifyCheck(observation, criteria);
  return { result, transition: applyCheckOutcome(state, result.outcome, thresholds) };
}
