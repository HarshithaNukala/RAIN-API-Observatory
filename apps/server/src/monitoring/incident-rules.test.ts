import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  applyCheckOutcome,
  type CheckResult,
  type HealthState,
} from './health.js';
import { planIncident, type IncidentCheck } from './incident-rules.js';

const at = new Date('2026-11-18T10:00:00.000Z');
const ok: CheckResult = { outcome: 'SUCCESS', statusCode: 200, latencyMs: 90, failureReason: null };
const slow: CheckResult = {
  outcome: 'DEGRADED',
  statusCode: 200,
  latencyMs: 4000,
  failureReason: null,
};
const down: CheckResult = {
  outcome: 'FAILURE',
  statusCode: null,
  latencyMs: null,
  failureReason: 'TIMEOUT',
};
const http503: CheckResult = {
  outcome: 'FAILURE',
  statusCode: 503,
  latencyMs: 30,
  failureReason: 'UNEXPECTED_STATUS',
};

const check = (result: CheckResult, errorMessage: string | null = null): IncidentCheck => ({
  id: '00000000-0000-4000-8000-000000000001',
  checkedAt: at,
  result,
  errorMessage,
});

function step(
  state: HealthState,
  result: CheckResult,
  active: { id: string } | null,
  thresholds = DEFAULT_HEALTH_THRESHOLDS,
) {
  const transition = applyCheckOutcome(state, result.outcome, thresholds);
  return {
    state: transition.next,
    action: planIncident({
      transition,
      active,
      monitorName: 'Payments',
      check: check(result),
      thresholds,
    }),
  };
}

const healthy: HealthState = { status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 5 };

describe('planIncident', () => {
  it('does nothing on the first failure (DEGRADED)', () => {
    expect(step(healthy, down, null).action).toEqual({ kind: 'none' });
  });

  it('opens on the transition to DOWN, recording the trigger check and a safe summary', () => {
    const first = step(healthy, http503, null);
    const second = planIncident({
      transition: applyCheckOutcome(first.state, 'FAILURE'),
      active: null,
      monitorName: 'Payments',
      check: check(
        http503,
        'GET https://api.example.com/health: expected status 200, received 503',
      ),
      thresholds: DEFAULT_HEALTH_THRESHOLDS,
    });
    expect(second).toMatchObject({
      kind: 'open',
      title: 'Payments is down',
      severity: 'HIGH',
      startedAt: at,
      triggerCheckId: check(down).id,
    });
    expect(second.kind === 'open' && second.description).toBe(
      'Detected automatically after 2 consecutive failed checks. Last check: unexpected HTTP status (HTTP 503). GET https://api.example.com/health: expected status 200, received 503',
    );
    expect(second.kind === 'open' && second.eventDescription).toMatch(
      /went DOWN after 2 consecutive/,
    );
  });

  it('never opens a second incident while one is active, however many failures follow', () => {
    let state: HealthState = { status: 'DOWN', consecutiveFailures: 2, consecutiveSuccesses: 0 };
    for (let i = 0; i < 5; i++) {
      const r = step(state, down, { id: 'active' });
      expect(r.action).toEqual({ kind: 'none' });
      state = r.state;
    }
  });

  it('opens for a monitor already DOWN without an active incident (e.g. state from before incidents existed)', () => {
    const state: HealthState = { status: 'DOWN', consecutiveFailures: 4, consecutiveSuccesses: 0 };
    expect(step(state, down, null).action.kind).toBe('open');
  });

  it('keeps the incident open after the first passing check (DOWN → DEGRADED)', () => {
    const state: HealthState = { status: 'DOWN', consecutiveFailures: 3, consecutiveSuccesses: 0 };
    const r = step(state, ok, { id: 'active' });
    expect(r.state.status).toBe('DEGRADED');
    expect(r.action).toEqual({ kind: 'none' });
  });

  it('resolves at the recovery threshold', () => {
    const first = step({ status: 'DOWN', consecutiveFailures: 3, consecutiveSuccesses: 0 }, ok, {
      id: 'inc',
    });
    const second = step(first.state, ok, { id: 'inc' });
    expect(second.state.status).toBe('HEALTHY');
    expect(second.action).toMatchObject({ kind: 'resolve', incidentId: 'inc', resolvedAt: at });
    expect(second.action.kind === 'resolve' && second.action.eventDescription).toBe(
      'Resolved automatically after 2 consecutive successful checks (last check: HTTP 200, 90 ms). Monitor is now HEALTHY.',
    );
  });

  it('counts slow expected responses toward recovery; the monitor stays DEGRADED', () => {
    const first = step({ status: 'DOWN', consecutiveFailures: 2, consecutiveSuccesses: 0 }, slow, {
      id: 'inc',
    });
    const second = step(first.state, slow, { id: 'inc' });
    expect(second.state.status).toBe('DEGRADED');
    expect(second.action.kind).toBe('resolve');
  });

  it('a failure during recovery resets the count: no resolution until two passes in a row', () => {
    const active = { id: 'inc' };
    let r = step({ status: 'DOWN', consecutiveFailures: 2, consecutiveSuccesses: 0 }, ok, active);
    r = step(r.state, down, active); // Partial recovery interrupted.
    expect(r.action).toEqual({ kind: 'none' });
    expect(r.state).toMatchObject({ status: 'DEGRADED', consecutiveSuccesses: 0 });
    r = step(r.state, ok, active);
    expect(r.action).toEqual({ kind: 'none' });
    r = step(r.state, ok, active);
    expect(r.action.kind).toBe('resolve');
  });

  it('resolves on the first pass with a recovery threshold of 1', () => {
    const thresholds = { failure: 2, recovery: 1 };
    const r = step(
      { status: 'DOWN', consecutiveFailures: 2, consecutiveSuccesses: 0 },
      ok,
      { id: 'inc' },
      thresholds,
    );
    expect(r.action.kind).toBe('resolve');
  });

  it('does nothing for checks that did not affect health (no transition)', () => {
    expect(
      planIncident({
        transition: null,
        active: { id: 'inc' },
        monitorName: 'Payments',
        check: check(ok),
        thresholds: DEFAULT_HEALTH_THRESHOLDS,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('clips very long monitor names into the title limit', () => {
    const transition = applyCheckOutcome(
      { status: 'DEGRADED', consecutiveFailures: 1, consecutiveSuccesses: 0 },
      'FAILURE',
    );
    const action = planIncident({
      transition,
      active: null,
      monitorName: 'x'.repeat(300),
      check: check(down),
      thresholds: DEFAULT_HEALTH_THRESHOLDS,
    });
    expect(action.kind === 'open' && action.title.length).toBe(200);
  });
});
