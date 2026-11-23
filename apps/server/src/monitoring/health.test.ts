import { NO_RESPONSE_REASONS, type MonitorCheckOutcome } from '@rain/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_THRESHOLDS,
  INITIAL_HEALTH_STATE,
  InvalidObservationError,
  applyCheckOutcome,
  classifyCheck,
  evaluateCheck,
  nextConsecutiveFailures,
  nextConsecutiveSuccesses,
  nextStatusChangedAt,
  type HealthState,
} from './health.js';

const criteria = { expectedStatusCode: 200, latencyThresholdMs: 500 };
const response = (statusCode: number, latencyMs: number) =>
  ({ kind: 'response', statusCode, latencyMs }) as const;

/** Applies outcomes in order from a starting state and returns every intermediate status. */
function run(outcomes: MonitorCheckOutcome[], start: HealthState = INITIAL_HEALTH_STATE) {
  let state = start;
  const statuses = outcomes.map((outcome) => {
    state = applyCheckOutcome(state, outcome).next;
    return state.status;
  });
  return { statuses, state };
}

/** Like `run`, but also records whether each step counts as a status change. */
function trace(outcomes: MonitorCheckOutcome[], start: HealthState = INITIAL_HEALTH_STATE) {
  let state = start;
  return outcomes.map((outcome) => {
    const t = applyCheckOutcome(state, outcome);
    state = t.next;
    return [t.next.status, t.statusChanged] as const;
  });
}

const healthy: HealthState = { status: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 5 };
const down: HealthState = { status: 'DOWN', consecutiveFailures: 4, consecutiveSuccesses: 0 };

describe('classifyCheck', () => {
  it('classifies the expected status within the threshold as SUCCESS', () => {
    expect(classifyCheck(response(200, 120), criteria)).toEqual({
      outcome: 'SUCCESS',
      statusCode: 200,
      latencyMs: 120,
      failureReason: null,
    });
  });

  it('treats latency exactly at the threshold as SUCCESS', () => {
    expect(classifyCheck(response(200, 500), criteria).outcome).toBe('SUCCESS');
  });

  it('classifies the expected status above the threshold as DEGRADED', () => {
    expect(classifyCheck(response(200, 501), criteria)).toEqual({
      outcome: 'DEGRADED',
      statusCode: 200,
      latencyMs: 501,
      failureReason: null,
    });
  });

  it.each([
    ['a server error', 503],
    ['a client error', 404],
    ['a redirect', 301],
    ['another 2xx', 204],
  ])('classifies %s as FAILURE, keeping status and latency', (_label, statusCode) => {
    expect(classifyCheck(response(statusCode, 80), criteria)).toEqual({
      outcome: 'FAILURE',
      statusCode,
      latencyMs: 80,
      failureReason: 'UNEXPECTED_STATUS',
    });
  });

  it('uses the monitor’s own expected status, not a fixed 200', () => {
    const created = { expectedStatusCode: 201, latencyThresholdMs: 500 };
    expect(classifyCheck(response(201, 10), created).outcome).toBe('SUCCESS');
    expect(classifyCheck(response(200, 10), created).outcome).toBe('FAILURE');
  });

  it.each(NO_RESPONSE_REASONS)(
    'classifies a %s with no response as FAILURE with NULL status and latency',
    (reason) => {
      expect(classifyCheck({ kind: 'no-response', reason }, criteria)).toEqual({
        outcome: 'FAILURE',
        statusCode: null,
        latencyMs: null,
        failureReason: reason,
      });
    },
  );

  it('rounds latency to whole milliseconds before comparing', () => {
    expect(classifyCheck(response(200, 500.4), criteria)).toMatchObject({
      outcome: 'SUCCESS',
      latencyMs: 500,
    });
    expect(classifyCheck(response(200, 500.6), criteria)).toMatchObject({
      outcome: 'DEGRADED',
      latencyMs: 501,
    });
  });

  it.each([
    ['a status below 100', response(99, 10)],
    ['a status above 599', response(600, 10)],
    ['a fractional status', response(200.5, 10)],
    ['a negative latency', response(200, -1)],
    ['a NaN latency', response(200, Number.NaN)],
    ['an infinite latency', response(200, Number.POSITIVE_INFINITY)],
  ])('rejects %s instead of recording nonsense', (_label, observation) => {
    expect(() => classifyCheck(observation, criteria)).toThrow(InvalidObservationError);
  });
});

describe('consecutive counters', () => {
  it('counts failures and resets them on any passing check', () => {
    expect(nextConsecutiveFailures(0, 'FAILURE')).toBe(1);
    expect(nextConsecutiveFailures(4, 'FAILURE')).toBe(5);
    expect(nextConsecutiveFailures(4, 'SUCCESS')).toBe(0);
    expect(nextConsecutiveFailures(4, 'DEGRADED')).toBe(0);
  });

  it('counts passing checks (fast or slow) and resets them on a failure', () => {
    expect(nextConsecutiveSuccesses(0, 'SUCCESS')).toBe(1);
    expect(nextConsecutiveSuccesses(2, 'DEGRADED')).toBe(3);
    expect(nextConsecutiveSuccesses(7, 'FAILURE')).toBe(0);
  });
});

describe('applyCheckOutcome', () => {
  it('uses a failure threshold of 2 and a recovery threshold of 2 by default', () => {
    expect(DEFAULT_HEALTH_THRESHOLDS).toEqual({ failure: 2, recovery: 2 });
  });

  describe('from UNKNOWN (no checks yet)', () => {
    it('becomes HEALTHY on the first successful check', () => {
      const t = applyCheckOutcome(INITIAL_HEALTH_STATE, 'SUCCESS');
      expect(t.next).toEqual({
        status: 'HEALTHY',
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
      });
      expect(t.statusChanged).toBe(true);
    });

    it('becomes DEGRADED on the first slow check', () => {
      expect(applyCheckOutcome(INITIAL_HEALTH_STATE, 'DEGRADED').next.status).toBe('DEGRADED');
    });

    it('becomes DEGRADED on the first failure and DOWN on the second', () => {
      expect(trace(['FAILURE', 'FAILURE'])).toEqual([
        ['DEGRADED', true],
        ['DOWN', true],
      ]);
    });
  });

  describe('normal responses', () => {
    it('stays HEALTHY through repeated successes, counting them', () => {
      const { statuses, state } = run(['SUCCESS', 'SUCCESS', 'SUCCESS']);
      expect(statuses).toEqual(['HEALTHY', 'HEALTHY', 'HEALTHY']);
      expect(state.consecutiveSuccesses).toBe(3);
    });

    it('moves between HEALTHY and DEGRADED with the latest latency', () => {
      expect(trace(['SUCCESS', 'DEGRADED', 'DEGRADED', 'SUCCESS'])).toEqual([
        ['HEALTHY', true],
        ['DEGRADED', true],
        ['DEGRADED', false],
        ['HEALTHY', true],
      ]);
    });
  });

  describe('failure transitions', () => {
    it('first consecutive failure: DEGRADED, and consecutive successes reset', () => {
      const t = applyCheckOutcome(healthy, 'FAILURE');
      expect(t.next).toEqual({
        status: 'DEGRADED',
        consecutiveFailures: 1,
        consecutiveSuccesses: 0,
      });
      expect(t.statusChanged).toBe(true);
    });

    it('second consecutive failure: DOWN', () => {
      const t = applyCheckOutcome(applyCheckOutcome(healthy, 'FAILURE').next, 'FAILURE');
      expect(t.next).toEqual({ status: 'DOWN', consecutiveFailures: 2, consecutiveSuccesses: 0 });
      expect(t.statusChanged).toBe(true);
    });

    it('further failures: stays DOWN, keeps counting, and reports no further change', () => {
      expect(trace(['FAILURE', 'FAILURE', 'FAILURE', 'FAILURE'], healthy)).toEqual([
        ['DEGRADED', true],
        ['DOWN', true],
        ['DOWN', false],
        ['DOWN', false],
      ]);
      expect(run(['FAILURE', 'FAILURE', 'FAILURE', 'FAILURE'], healthy).state).toEqual({
        status: 'DOWN',
        consecutiveFailures: 4,
        consecutiveSuccesses: 0,
      });
    });

    it('a first failure on an already DEGRADED monitor keeps it DEGRADED without a change', () => {
      const t = applyCheckOutcome({ ...healthy, status: 'DEGRADED' }, 'FAILURE');
      expect(t.next.status).toBe('DEGRADED');
      expect(t.statusChanged).toBe(false);
    });

    it('a passing check between failures resets the count, so DOWN needs two in a row', () => {
      expect(run(['FAILURE', 'SUCCESS', 'FAILURE', 'SUCCESS'], healthy).statuses).toEqual([
        'DEGRADED',
        'HEALTHY',
        'DEGRADED',
        'HEALTHY',
      ]);
    });
  });

  describe('recovery transitions', () => {
    it('first successful expected-status response while DOWN: DEGRADED', () => {
      const t = applyCheckOutcome(down, 'SUCCESS');
      expect(t.next).toEqual({
        status: 'DEGRADED',
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
      });
      expect(t.statusChanged).toBe(true);
    });

    it('second consecutive success: HEALTHY when fast', () => {
      expect(trace(['SUCCESS', 'SUCCESS'], down)).toEqual([
        ['DEGRADED', true],
        ['HEALTHY', true],
      ]);
    });

    it('second consecutive success: DEGRADED when slow, with no further change', () => {
      expect(trace(['SUCCESS', 'DEGRADED'], down)).toEqual([
        ['DEGRADED', true],
        ['DEGRADED', false],
      ]);
    });

    it('a slow first response still counts towards recovery', () => {
      expect(trace(['DEGRADED', 'SUCCESS'], down)).toEqual([
        ['DEGRADED', true],
        ['HEALTHY', true],
      ]);
    });

    it('a failure during recovery resets the successes and applies the failure rules', () => {
      const first = applyCheckOutcome(down, 'SUCCESS').next;
      const failed = applyCheckOutcome(first, 'FAILURE');
      // One consecutive failure: DEGRADED (unchanged), success count reset.
      expect(failed.next).toEqual({
        status: 'DEGRADED',
        consecutiveFailures: 1,
        consecutiveSuccesses: 0,
      });
      expect(failed.statusChanged).toBe(false);
      // A second consecutive failure: back to DOWN.
      expect(applyCheckOutcome(failed.next, 'FAILURE').next.status).toBe('DOWN');
    });

    it('needs two consecutive successes again after a failed recovery', () => {
      expect(trace(['SUCCESS', 'FAILURE', 'FAILURE', 'SUCCESS', 'SUCCESS'], down)).toEqual([
        ['DEGRADED', true],
        ['DEGRADED', false],
        ['DOWN', true],
        ['DEGRADED', true],
        ['HEALTHY', true],
      ]);
    });

    it('follows a full outage and recovery', () => {
      expect(
        run([
          'SUCCESS',
          'FAILURE',
          'FAILURE',
          'FAILURE',
          'SUCCESS',
          'FAILURE',
          'SUCCESS',
          'SUCCESS',
          'DEGRADED',
          'SUCCESS',
        ]).statuses,
      ).toEqual([
        'HEALTHY',
        'DEGRADED',
        'DOWN',
        'DOWN',
        'DEGRADED',
        'DEGRADED',
        'HEALTHY',
        'HEALTHY',
        'DEGRADED',
        'HEALTHY',
      ]);
    });
  });

  describe('custom thresholds', () => {
    it('honours another failure threshold, degrading until it is reached', () => {
      const thresholds = { failure: 3, recovery: 2 };
      let state = INITIAL_HEALTH_STATE;
      const statuses = (['FAILURE', 'FAILURE', 'FAILURE'] as const).map((o) => {
        state = applyCheckOutcome(state, o, thresholds).next;
        return state.status;
      });
      expect(statuses).toEqual(['DEGRADED', 'DEGRADED', 'DOWN']);
    });

    it('goes straight to DOWN with a failure threshold of 1', () => {
      const t = applyCheckOutcome(healthy, 'FAILURE', { failure: 1, recovery: 2 });
      expect(t.next.status).toBe('DOWN');
    });

    it('recovers on the first passing check with a recovery threshold of 1', () => {
      const t = applyCheckOutcome(down, 'SUCCESS', { failure: 2, recovery: 1 });
      expect(t.next.status).toBe('HEALTHY');
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects an invalid threshold (%s)', (value) => {
      expect(() =>
        applyCheckOutcome(INITIAL_HEALTH_STATE, 'FAILURE', { failure: value, recovery: 2 }),
      ).toThrow(RangeError);
      expect(() =>
        applyCheckOutcome(INITIAL_HEALTH_STATE, 'FAILURE', { failure: 2, recovery: value }),
      ).toThrow(RangeError);
    });

    it('rejects a recovery threshold above 2, which the stored state cannot track', () => {
      expect(() => applyCheckOutcome(down, 'SUCCESS', { failure: 2, recovery: 3 })).toThrow(
        /recovery threshold must be 1 or 2/,
      );
    });
  });

  it('never mutates the state it is given', () => {
    const state: HealthState = {
      status: 'HEALTHY',
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
    };
    const frozen = Object.freeze({ ...state });
    const t = applyCheckOutcome(frozen, 'FAILURE');
    expect(frozen).toEqual(state);
    expect(t.previous).toBe(frozen);
  });
});

describe('nextStatusChangedAt', () => {
  const earlier = new Date('2026-11-17T09:00:00.000Z');
  const checkedAt = new Date('2026-11-17T10:00:00.000Z');

  it('records the check time when the status changes', () => {
    const t = applyCheckOutcome(healthy, 'FAILURE');
    expect(nextStatusChangedAt(t, checkedAt, earlier)).toBe(checkedAt);
  });

  it('keeps the stored time when the status stays the same', () => {
    const t = applyCheckOutcome(healthy, 'SUCCESS');
    expect(nextStatusChangedAt(t, checkedAt, earlier)).toBe(earlier);
    expect(nextStatusChangedAt(t, checkedAt, null)).toBeNull();
  });

  it('sets it on the first transition out of UNKNOWN', () => {
    const t = applyCheckOutcome(INITIAL_HEALTH_STATE, 'SUCCESS');
    expect(nextStatusChangedAt(t, checkedAt, null)).toBe(checkedAt);
  });

  it('changes at each status change of an outage and recovery, and only then', () => {
    const outcomes = [
      'FAILURE',
      'FAILURE',
      'FAILURE',
      'SUCCESS',
      'SUCCESS',
      'SUCCESS',
      'DEGRADED',
    ] as const;
    let state = healthy;
    let changedAt: Date | null = earlier;
    const recorded = outcomes.map((outcome, i) => {
      const t = applyCheckOutcome(state, outcome);
      state = t.next;
      changedAt = nextStatusChangedAt(t, new Date(Date.UTC(2026, 10, 17, 10, i)), changedAt);
      return [state.status, changedAt?.toISOString().slice(11, 16)];
    });
    expect(recorded).toEqual([
      ['DEGRADED', '10:00'], // first failure: changed
      ['DOWN', '10:01'], // second failure: changed
      ['DOWN', '10:01'], // still DOWN: kept
      ['DEGRADED', '10:03'], // first recovery success: changed
      ['HEALTHY', '10:04'], // second success, fast: changed
      ['HEALTHY', '10:04'], // unchanged: kept
      ['DEGRADED', '10:06'], // slow: changed
    ]);
  });
});

describe('evaluateCheck', () => {
  it('classifies and applies one observation', () => {
    const { result, transition } = evaluateCheck(
      { status: 'DEGRADED', consecutiveFailures: 1, consecutiveSuccesses: 0 },
      { kind: 'no-response', reason: 'TIMEOUT' },
      criteria,
    );
    expect(result).toEqual({
      outcome: 'FAILURE',
      statusCode: null,
      latencyMs: null,
      failureReason: 'TIMEOUT',
    });
    expect(transition.next.status).toBe('DOWN');
    expect(transition.statusChanged).toBe(true);
  });
});
