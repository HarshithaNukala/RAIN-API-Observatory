import { randomUUID } from 'node:crypto';
import type { NoResponseReason } from '@rain/shared';
import { describe, expect, it } from 'vitest';
import type { MonitorRow } from '../db/schema.js';
import {
  claimSource,
  planCompletion,
  planRelease,
  type ClaimedMonitor,
  type CompletionSnapshot,
} from './completion.js';
import type { CheckExecution } from './executor.js';

const t = (iso: string) => new Date(`2026-11-18T${iso}Z`);
const TOKEN = randomUUID();

function monitorRow(overrides: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: randomUUID(),
    ownerId: randomUUID(),
    name: 'Payments',
    description: null,
    url: 'https://api.example.com/health',
    method: 'GET',
    expectedStatusCode: 200,
    timeoutMs: 10_000,
    latencyThresholdMs: 2000,
    checkIntervalSeconds: 60,
    requestBodyCiphertext: null,
    requestBodyIv: null,
    requestBodyAuthTag: null,
    requestBodyKeyVersion: null,
    bodyContentType: null,
    allowMutatingRequests: false,
    enabled: true,
    currentStatus: 'UNKNOWN',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    statusChangedAt: null,
    lastCheckedAt: null,
    nextCheckAt: t('10:00:00'),
    leaseUntil: t('10:01:30'),
    leaseToken: TOKEN,
    manualCheckRequestedAt: null,
    lastManualCheckAt: null,
    createdAt: t('09:00:00'),
    updatedAt: t('09:00:00'),
    ...overrides,
  };
}

function claimOf(row: MonitorRow, overrides: Partial<ClaimedMonitor> = {}): ClaimedMonitor {
  return {
    monitor: row,
    leaseToken: row.leaseToken!,
    claimedAt: t('10:00:00.100'),
    due: row.nextCheckAt.getTime() <= t('10:00:00.100').getTime(),
    manualRequestedAt: row.manualCheckRequestedAt,
    ...overrides,
  };
}

const snapshot = (row: MonitorRow, overrides: Partial<CompletionSnapshot> = {}) => ({
  ...row,
  ...overrides,
});

const ok = (latencyMs = 120, checkedAt = t('10:00:00.100')): CheckExecution => ({
  checkedAt,
  result: { outcome: 'SUCCESS', statusCode: 200, latencyMs, failureReason: null },
  errorMessage: null,
  response: { bodyBytesRead: 2, bodyLimitReached: false },
});
const slow = (): CheckExecution => ({
  ...ok(),
  result: { outcome: 'DEGRADED', statusCode: 200, latencyMs: 2500, failureReason: null },
});
const failed = (reason: NoResponseReason = 'CONNECTION_ERROR'): CheckExecution => ({
  checkedAt: t('10:00:00.100'),
  result: { outcome: 'FAILURE', statusCode: null, latencyMs: null, failureReason: reason },
  errorMessage: `GET https://api.example.com/health: ${reason}`,
  response: null,
});
const wrongStatus = (): CheckExecution => ({
  checkedAt: t('10:00:00.100'),
  result: {
    outcome: 'FAILURE',
    statusCode: 503,
    latencyMs: 40,
    failureReason: 'UNEXPECTED_STATUS',
  },
  errorMessage: 'expected status 200, received 503',
  response: { bodyBytesRead: 0, bodyLimitReached: false },
});

const NOW = t('10:00:00.300');

function record(
  row: MonitorRow,
  execution: CheckExecution,
  claim = claimOf(row),
  current = snapshot(row),
) {
  const plan = planCompletion(current, claim, execution, NOW);
  if (plan.kind !== 'record') throw new Error(`expected a record plan, got ${plan.reason}`);
  return plan;
}

describe('planCompletion: lease decisions', () => {
  it('discards the result of a stale worker whose lease was re-claimed by another', () => {
    const row = monitorRow();
    const plan = planCompletion(
      snapshot(row, { leaseToken: randomUUID() }),
      claimOf(row),
      ok(),
      NOW,
    );
    expect(plan).toEqual({ kind: 'discard', reason: 'LEASE_LOST' });
  });

  it('discards when the lease was released (token cleared)', () => {
    const row = monitorRow();
    const plan = planCompletion(snapshot(row, { leaseToken: null }), claimOf(row), ok(), NOW);
    expect(plan).toEqual({ kind: 'discard', reason: 'LEASE_LOST' });
  });

  it('discards when the monitor was deleted during the check', () => {
    const row = monitorRow();
    expect(planCompletion(undefined, claimOf(row), ok(), NOW)).toEqual({
      kind: 'discard',
      reason: 'MONITOR_DELETED',
    });
  });

  it('accepts a completion after lease expiry if nobody re-claimed (token still matches)', () => {
    const row = monitorRow({ leaseUntil: t('09:59:00') });
    expect(planCompletion(snapshot(row), claimOf(row), ok(), NOW).kind).toBe('record');
  });

  it('always clears the lease and uses the lease token as the attempt ID', () => {
    const plan = record(monitorRow(), ok());
    expect(plan.update).toMatchObject({ leaseUntil: null, leaseToken: null });
    expect(plan.check.attemptId).toBe(TOKEN);
  });
});

describe('planCompletion: recorded check', () => {
  it('stores status and latency for a response', () => {
    const plan = record(monitorRow(), ok(87));
    expect(plan.check).toMatchObject({
      outcome: 'SUCCESS',
      statusCode: 200,
      latencyMs: 87,
      failureReason: null,
      errorMessage: null,
      source: 'SCHEDULED',
      checkedAt: t('10:00:00.100'),
    });
  });

  it('stores NULL status and NULL latency when no response arrived', () => {
    const plan = record(monitorRow(), failed('TIMEOUT'));
    expect(plan.check).toMatchObject({
      statusCode: null,
      latencyMs: null,
      failureReason: 'TIMEOUT',
    });
  });

  it('truncates long error messages to the column limit', () => {
    const execution = { ...failed(), errorMessage: 'x'.repeat(2000) };
    expect(record(monitorRow(), execution).check.errorMessage).toHaveLength(500);
  });
});

describe('planCompletion: health', () => {
  it('first success from UNKNOWN → HEALTHY and stamps status_changed_at', () => {
    const plan = record(monitorRow(), ok());
    expect(plan.update).toMatchObject({
      currentStatus: 'HEALTHY',
      consecutiveSuccesses: 1,
      consecutiveFailures: 0,
      statusChangedAt: t('10:00:00.100'),
      lastCheckedAt: t('10:00:00.100'),
    });
  });

  it('keeps status_changed_at when the status does not change', () => {
    const changed = t('08:00:00');
    const row = monitorRow({
      currentStatus: 'HEALTHY',
      consecutiveSuccesses: 3,
      statusChangedAt: changed,
    });
    expect(record(row, ok()).update.statusChangedAt).toEqual(changed);
  });

  it('first failure → DEGRADED, second → DOWN', () => {
    const healthy = monitorRow({ currentStatus: 'HEALTHY', consecutiveSuccesses: 4 });
    const first = record(healthy, failed());
    expect(first.update).toMatchObject({ currentStatus: 'DEGRADED', consecutiveFailures: 1 });
    const degraded = monitorRow({ currentStatus: 'DEGRADED', consecutiveFailures: 1 });
    expect(record(degraded, wrongStatus()).update).toMatchObject({
      currentStatus: 'DOWN',
      consecutiveFailures: 2,
    });
  });

  it('recovery: first success after DOWN → DEGRADED, second → HEALTHY', () => {
    const down = monitorRow({ currentStatus: 'DOWN', consecutiveFailures: 3 });
    expect(record(down, ok()).update).toMatchObject({
      currentStatus: 'DEGRADED',
      consecutiveSuccesses: 1,
    });
    const recovering = monitorRow({ currentStatus: 'DEGRADED', consecutiveSuccesses: 1 });
    expect(record(recovering, ok()).update).toMatchObject({ currentStatus: 'HEALTHY' });
  });

  it('a slow expected response passes but gives DEGRADED', () => {
    const row = monitorRow({ currentStatus: 'HEALTHY', consecutiveSuccesses: 2 });
    const plan = record(row, slow());
    expect(plan.update).toMatchObject({
      currentStatus: 'DEGRADED',
      consecutiveFailures: 0,
      consecutiveSuccesses: 3,
    });
  });

  it.each(['BLOCKED_DESTINATION', 'CONFIGURATION_ERROR'] as const)(
    '%s is recorded but never changes health or counters',
    (reason) => {
      const row = monitorRow({
        currentStatus: 'HEALTHY',
        consecutiveSuccesses: 5,
        consecutiveFailures: 0,
      });
      const plan = record(row, failed(reason));
      expect(plan.healthSkipped).toBe('HEALTH_NEUTRAL');
      expect(plan.transition).toBeNull();
      expect(plan.check.failureReason).toBe(reason);
      expect(plan.update).not.toHaveProperty('currentStatus');
      expect(plan.update).not.toHaveProperty('consecutiveFailures');
      expect(plan.update.lastCheckedAt).toEqual(t('10:00:00.100'));
    },
  );

  it('repeated SSRF rejections never mark a monitor DOWN', () => {
    let row = monitorRow({ currentStatus: 'UNKNOWN' });
    for (let i = 0; i < 5; i++) {
      const plan = record(row, failed('BLOCKED_DESTINATION'));
      row = { ...row, ...plan.update, leaseToken: TOKEN };
    }
    expect(row.currentStatus).toBe('UNKNOWN');
    expect(row.consecutiveFailures).toBe(0);
  });

  it('paused during the check: records history, leaves health exactly as it was', () => {
    const row = monitorRow({ currentStatus: 'HEALTHY', consecutiveSuccesses: 2 });
    const plan = record(row, failed(), claimOf(row), snapshot(row, { enabled: false }));
    expect(plan.healthSkipped).toBe('PAUSED');
    expect(plan.update).not.toHaveProperty('currentStatus');
    expect(plan.update.nextCheckAt).toEqual(row.nextCheckAt);
  });
});

describe('planCompletion: scheduling', () => {
  it('advances a due scheduled check from the previous schedule (no drift)', () => {
    const plan = record(monitorRow({ nextCheckAt: t('10:00:00') }), ok());
    expect(plan.update.nextCheckAt).toEqual(t('10:01:00'));
  });

  it('skips missed intervals', () => {
    const row = monitorRow({ nextCheckAt: t('09:52:00') });
    const plan = record(row, ok(), claimOf(row, { due: true }));
    expect(plan.update.nextCheckAt).toEqual(t('10:01:00'));
  });

  it('a manual check that was not due leaves the cadence alone', () => {
    const row = monitorRow({ nextCheckAt: t('10:00:40'), manualCheckRequestedAt: t('09:59:59') });
    const claim = claimOf(row, { due: false });
    const plan = record(row, ok(), claim);
    expect(claimSource(claim)).toBe('MANUAL');
    expect(plan.check.source).toBe('MANUAL');
    expect(plan.update.nextCheckAt).toEqual(t('10:00:40'));
  });

  it('keeps a schedule someone else changed during the check (e.g. resume)', () => {
    const row = monitorRow({ nextCheckAt: t('10:00:00') });
    const current = snapshot(row, { nextCheckAt: t('10:00:05') });
    expect(record(row, ok(), claimOf(row), current).update.nextCheckAt).toEqual(t('10:00:05'));
  });

  it('uses the interval as it is now, not as it was at claim', () => {
    const row = monitorRow({ nextCheckAt: t('10:00:00') });
    const current = snapshot(row, { checkIntervalSeconds: 300 });
    expect(record(row, ok(), claimOf(row), current).update.nextCheckAt).toEqual(t('10:05:00'));
  });
});

describe('planCompletion: manual requests', () => {
  it('clears the served manual request and stamps last_manual_check_at', () => {
    const row = monitorRow({ manualCheckRequestedAt: t('09:59:59') });
    const plan = record(row, ok());
    expect(plan.update.manualCheckRequestedAt).toBeNull();
    expect(plan.update.lastManualCheckAt).toEqual(t('10:00:00.100'));
  });

  it('keeps a manual request queued after a scheduled claim (served by the next poll)', () => {
    const row = monitorRow();
    const current = snapshot(row, { manualCheckRequestedAt: t('10:00:00.200') });
    const plan = record(row, ok(), claimOf(row), current);
    expect(plan.check.source).toBe('SCHEDULED');
    expect(plan.update.manualCheckRequestedAt).toEqual(t('10:00:00.200'));
    expect(plan.update.lastManualCheckAt).toBeNull();
  });

  it('does not resurrect a manual request the owner cancelled by pausing', () => {
    const row = monitorRow({ manualCheckRequestedAt: t('09:59:59') });
    const current = snapshot(row, { enabled: false, manualCheckRequestedAt: null });
    expect(record(row, ok(), claimOf(row), current).update.manualCheckRequestedAt).toBeNull();
  });
});

describe('planRelease', () => {
  it('clears the lease, advances a due schedule, drops the served manual request', () => {
    const row = monitorRow({ manualCheckRequestedAt: t('09:59:59') });
    const plan = planRelease(snapshot(row), claimOf(row), NOW);
    expect(plan).toEqual({
      kind: 'release',
      update: {
        nextCheckAt: t('10:01:00'),
        manualCheckRequestedAt: null,
        leaseUntil: null,
        leaseToken: null,
      },
    });
  });

  it('never touches a lease that is no longer ours', () => {
    const row = monitorRow();
    expect(planRelease(snapshot(row, { leaseToken: randomUUID() }), claimOf(row), NOW)).toEqual({
      kind: 'discard',
      reason: 'LEASE_LOST',
    });
  });
});
