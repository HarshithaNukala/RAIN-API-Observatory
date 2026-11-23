import {
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_LIMITS,
  type CheckFailureReason,
  type IncidentSeverity,
} from '@rain/shared';
import type { CheckResult, HealthThresholds, HealthTransition } from './health.js';
import { isPassing } from './health.js';

/**
 * When a recorded check opens or resolves an incident. Pure, like the rest of completion: the
 * PostgreSQL store calls it inside the completion transaction, with the monitor row locked and
 * after the check row was inserted, so the incident, its timeline event, the check and the
 * monitor's new health commit together or not at all.
 *
 * - **Open** when the check leaves the monitor DOWN and it has no active incident. A monitor that
 *   is already DOWN with an active incident gets no second one, however many failures follow.
 * - **Resolve** when the monitor has an active incident and this passing check brings the
 *   consecutive passing checks to the recovery threshold (expected status; slow responses count).
 *   The first passing check after an outage (DOWN → DEGRADED) is not enough with the default
 *   threshold of 2, and any failure resets the count.
 * - Checks that didn't affect health (paused monitor, SSRF or configuration refusal) never open
 *   or resolve anything.
 */

export interface ActiveIncident {
  id: string;
}

export interface IncidentCheck {
  id: string;
  checkedAt: Date;
  result: CheckResult;
  errorMessage: string | null;
}

export type IncidentAction =
  | { kind: 'none' }
  | {
      kind: 'open';
      title: string;
      description: string;
      severity: IncidentSeverity;
      startedAt: Date;
      triggerCheckId: string;
      eventDescription: string;
    }
  | {
      kind: 'resolve';
      incidentId: string;
      resolvedAt: Date;
      resolvedByCheckId: string;
      eventDescription: string;
    };

const REASON_TEXT: Record<CheckFailureReason, string> = {
  UNEXPECTED_STATUS: 'unexpected HTTP status',
  TIMEOUT: 'timed out',
  DNS_ERROR: 'DNS lookup failed',
  CONNECTION_ERROR: 'connection failed',
  TLS_ERROR: 'TLS error',
  BLOCKED_DESTINATION: 'destination not allowed',
  REQUEST_ERROR: 'request failed',
  CONFIGURATION_ERROR: 'not sent (configuration)',
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function lastCheckSummary(result: CheckResult): string {
  const reason = result.failureReason ? REASON_TEXT[result.failureReason] : 'failed';
  return result.statusCode === null ? reason : `${reason} (HTTP ${result.statusCode})`;
}

export function planIncident(input: {
  transition: HealthTransition | null;
  active: ActiveIncident | null;
  monitorName: string;
  check: IncidentCheck;
  thresholds: HealthThresholds;
}): IncidentAction {
  const { transition, active, monitorName, check, thresholds } = input;
  if (!transition) return { kind: 'none' };
  const { next } = transition;

  if (!active && next.status === 'DOWN') {
    const failures = next.consecutiveFailures;
    const summary = lastCheckSummary(check.result);
    // errorMessage is the executor's sanitised text (URL without query string or credentials).
    const detail = check.errorMessage ? ` ${check.errorMessage}` : '';
    return {
      kind: 'open',
      title: clip(`${monitorName} is down`, INCIDENT_LIMITS.titleMaxLength),
      description: clip(
        `Detected automatically after ${failures} consecutive failed checks. Last check: ${summary}.${detail}`,
        INCIDENT_LIMITS.descriptionMaxLength,
      ),
      severity: DEFAULT_INCIDENT_SEVERITY,
      startedAt: check.checkedAt,
      triggerCheckId: check.id,
      eventDescription: clip(
        `Incident opened: the monitor went DOWN after ${failures} consecutive failed checks (last check: ${summary}).`,
        INCIDENT_LIMITS.eventDescriptionMaxLength,
      ),
    };
  }

  if (
    active &&
    isPassing(check.result.outcome) &&
    next.consecutiveSuccesses >= thresholds.recovery
  ) {
    const latency = check.result.latencyMs === null ? '' : `, ${check.result.latencyMs} ms`;
    return {
      kind: 'resolve',
      incidentId: active.id,
      resolvedAt: check.checkedAt,
      resolvedByCheckId: check.id,
      eventDescription: clip(
        `Resolved automatically after ${next.consecutiveSuccesses} consecutive successful checks (last check: HTTP ${check.result.statusCode}${latency}). Monitor is now ${next.status}.`,
        INCIDENT_LIMITS.eventDescriptionMaxLength,
      ),
    };
  }

  return { kind: 'none' };
}
