import { randomBytes, randomUUID } from 'node:crypto';
import { CreateMonitorSchema, UpdateNotificationSettingsSchema } from '@rain/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.js';
import type { ProfileStore } from '../db/profiles.js';
import { type AppError } from '../errors.js';
import type { CheckExecution } from '../monitoring/executor.js';
import { createMonitorService, type MonitorService } from '../monitors/monitor-service.js';
import {
  createInMemoryMonitorRepository,
  type InMemoryMonitorRepository,
} from '../test-support/in-memory-monitor-repository.js';
import {
  createInMemoryMonitoringStore,
  type InMemoryMonitoringStore,
} from '../test-support/in-memory-monitoring-store.js';
import {
  createInMemoryDispatchStore,
  createInMemoryNotificationRepository,
  type InMemoryDispatchStore,
} from '../test-support/in-memory-notification-store.js';
import { startLocalTarget, type LocalTarget } from '../test-support/local-target.js';
import type { EmailMessage, EmailProvider } from './email.js';
import { createNotificationDispatcher } from './notification-dispatcher.js';
import type { DeliveryResult } from './notification-rules.js';
import { createNotificationService, type NotificationService } from './notification-service.js';
import { createWebhookSender, verifyWebhookSignature } from './webhook-sender.js';

/**
 * Notifications end to end without a database: incident events queue deliveries inside the
 * in-memory completion "transaction"; the dispatcher delivers them with a fake email provider
 * (records messages, sends nothing) and the real webhook sender over the SSRF-safe transport to a
 * local server. SQL behaviour is in tests/integration/notifications.test.ts.
 */

const owner = randomUUID();
const stranger = randomUUID();
const OWNER_EMAIL = 'owner@example.com';
const secretBox = createSecretBox({ currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
const profiles: ProfileStore = {
  ensure: async (id) => ({
    id,
    displayName: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }),
};

let clock: number;
const now = () => new Date(clock);
let repo: InMemoryMonitorRepository;
let checks: InMemoryMonitoringStore;
let dispatch: InMemoryDispatchStore;
let monitorsSvc: MonitorService;
let notifications: NotificationService;
let target: LocalTarget;
let sentEmails: EmailMessage[];
let emailResults: DeliveryResult[];

const fakeEmail: EmailProvider = {
  configured: true,
  send: async (message) => {
    sentEmails.push(message);
    return emailResults.shift() ?? { outcome: 'SUCCESS', httpStatus: 200 };
  },
};

beforeEach(async () => {
  clock = Date.parse('2026-11-19T10:00:00.000Z');
  repo = createInMemoryMonitorRepository();
  repo.ownerEmails.set(owner, OWNER_EMAIL);
  checks = createInMemoryMonitoringStore(repo, { now });
  dispatch = createInMemoryDispatchStore(repo, { now });
  monitorsSvc = createMonitorService({
    repository: repo,
    profiles,
    secretBox,
    maxMonitorsPerUser: 50,
    now,
  });
  notifications = createNotificationService({
    repository: createInMemoryNotificationRepository(repo),
    secretBox,
    emailConfigured: true,
    now,
  });
  target = await startLocalTarget();
  sentEmails = [];
  emailResults = [];
});

afterEach(async () => {
  await target.close();
});

const dispatcher = (email: EmailProvider = fakeEmail) =>
  createNotificationDispatcher({
    store: dispatch,
    email,
    webhook: createWebhookSender({
      transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
      now,
    }),
    secretBox,
    logger: pino({ level: 'silent' }),
    appBaseUrl: 'https://rain.example.com',
    now,
    random: () => 1,
  });

const failure = (): CheckExecution => ({
  checkedAt: now(),
  result: {
    outcome: 'FAILURE',
    statusCode: 503,
    latencyMs: 20,
    failureReason: 'UNEXPECTED_STATUS',
  },
  errorMessage: 'GET https://api.example.com/health: expected status 200, received 503',
  response: null,
});
const success = (): CheckExecution => ({
  checkedAt: now(),
  result: { outcome: 'SUCCESS', statusCode: 200, latencyMs: 50, failureReason: null },
  errorMessage: null,
  response: null,
});

async function createMonitor() {
  return monitorsSvc.create(
    owner,
    CreateMonitorSchema.parse({
      name: 'Payments',
      url: 'https://api.example.com/health',
      checkIntervalSeconds: 60,
    }),
  );
}

/** One check through the real completion logic (claim → complete). */
async function runCheck(monitorId: string, execution: CheckExecution) {
  const row = repo.monitors.find((m) => m.id === monitorId)!;
  row.nextCheckAt = new Date(clock - 1000);
  const [claim] = await checks.claim(10, 90);
  const result = await checks.complete(claim!, execution);
  clock += 60_000;
  return result;
}

async function configure(monitorId: string, patch: unknown) {
  return notifications.updateSettings(
    owner,
    OWNER_EMAIL,
    monitorId,
    UpdateNotificationSettingsSchema.parse(patch),
  );
}

// Plain HTTP: the local target behind the safe transport doesn't speak TLS.
const webhookUrl = 'http://hooks.example.com/rain';

describe('queueing in the incident transaction', () => {
  it('incident creation queues one delivery per enabled channel', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true, webhook: { enabled: true, url: webhookUrl } });
    await runCheck(m.id, failure());
    expect(repo.notificationDeliveries).toHaveLength(0); // First failure: no incident.
    const result = await runCheck(m.id, failure());
    expect(result).toMatchObject({ incident: { action: 'OPENED' }, notificationsQueued: 2 });
    expect(
      repo.notificationDeliveries.map((d) => [d.channel, d.eventType, d.status, d.destination]),
    ).toEqual([
      ['EMAIL', 'INCIDENT_CREATED', 'PENDING', 'o•••@example.com'],
      ['WEBHOOK', 'INCIDENT_CREATED', 'PENDING', 'hooks.example.com'],
    ]);
    const event = repo.incidentEvents.find((e) => e.eventType === 'INCIDENT_CREATED')!;
    expect(repo.notificationDeliveries.every((d) => d.eventId === event.id)).toBe(true);
  });

  it('repeated failures during the incident queue nothing more; resolution queues once per channel', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true, webhook: { enabled: true, url: webhookUrl } });
    for (let i = 0; i < 5; i++) await runCheck(m.id, failure());
    expect(repo.notificationDeliveries).toHaveLength(2);
    await runCheck(m.id, success());
    expect(repo.notificationDeliveries).toHaveLength(2); // First pass: still open.
    const resolved = await runCheck(m.id, success());
    expect(resolved).toMatchObject({ incident: { action: 'RESOLVED' }, notificationsQueued: 2 });
    const resolutions = repo.notificationDeliveries.filter(
      (d) => d.eventType === 'INCIDENT_RESOLVED',
    );
    expect(resolutions).toHaveLength(2);
    expect(resolutions[0]!.payload).toMatchObject({
      incident: { status: 'RESOLVED', title: 'Payments is down' },
    });
  });

  it('a duplicated completion of the same attempt queues no duplicate jobs', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    await runCheck(m.id, failure());
    const row = repo.monitors.find((x) => x.id === m.id)!;
    row.nextCheckAt = new Date(clock - 1000);
    const [claim] = await checks.claim(10, 90);
    const execution = failure();
    await checks.complete(claim!, execution);
    row.leaseToken = claim!.leaseToken;
    expect(await checks.complete(claim!, execution)).toEqual({
      recorded: false,
      reason: 'DUPLICATE_ATTEMPT',
    });
    expect(repo.notificationDeliveries).toHaveLength(1);
  });

  it('disabled or unconfigured channels receive no jobs', async () => {
    const m = await createMonitor();
    await runCheck(m.id, failure());
    await runCheck(m.id, failure()); // No settings at all.
    expect(repo.incidents).toHaveLength(1);
    expect(repo.notificationDeliveries).toHaveLength(0);

    const other = await createMonitor();
    await configure(other.id, {
      emailEnabled: false,
      webhook: { enabled: false, url: webhookUrl },
    });
    await runCheck(other.id, failure());
    await runCheck(other.id, failure());
    expect(repo.notificationDeliveries).toHaveLength(0);
  });

  it('skips email when the account has no address', async () => {
    repo.ownerEmails.set(owner, null);
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    expect(repo.notificationDeliveries).toHaveLength(0);
  });

  it('rolls back the queued jobs with the incident when the transaction fails', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    await runCheck(m.id, failure());
    checks.failNext('incident');
    await expect(runCheck(m.id, failure())).rejects.toThrow();
    expect(repo.incidents).toHaveLength(0);
    expect(repo.notificationDeliveries).toHaveLength(0);
  });
});

describe('dispatcher', () => {
  async function openIncident(patch: unknown) {
    const m = await createMonitor();
    const { signingSecret } = await configure(m.id, patch);
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    return { monitor: m, signingSecret };
  }

  it('delivers email with the incident details and marks it SENT with an attempt record', async () => {
    const { monitor } = await openIncident({ emailEnabled: true });
    expect(await dispatcher().pollOnce()).toBe(1);
    const [email] = sentEmails;
    const delivery = repo.notificationDeliveries[0]!;
    expect(email).toMatchObject({
      to: OWNER_EMAIL,
      idempotencyKey: delivery.id,
      subject: '[RAIN] Incident opened: Payments is down',
    });
    expect(email!.html).toContain(`https://rain.example.com/app/incidents/${delivery.incidentId}`);
    expect(delivery).toMatchObject({
      status: 'SENT',
      attempts: 1,
      leaseToken: null,
      lastError: null,
    });
    const detail = await notifications.get(owner, delivery.id);
    expect(detail.attemptHistory).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        outcome: 'SUCCESS',
        httpStatus: 200,
        error: null,
      }),
    ]);
    expect(detail.monitor).toEqual({ id: monitor.id, name: 'Payments' });
  });

  it('delivers a signed webhook the receiver can verify, with the stored auth header', async () => {
    const { signingSecret } = await openIncident({
      webhook: {
        enabled: true,
        url: webhookUrl,
        header: { name: 'Authorization', value: 'Bearer hook-token' },
      },
    });
    target.reply('/rain', 'POST', 200);
    await dispatcher().pollOnce();
    const [req] = target.captured;
    expect(req!.headers.authorization).toBe('Bearer hook-token');
    expect(
      verifyWebhookSignature({
        secret: signingSecret!,
        body: req!.body!,
        signature: req!.headers['x-rain-signature'],
        timestamp: req!.headers['x-rain-timestamp'],
        nowSeconds: Math.floor(clock / 1000),
      }),
    ).toBe(true);
    expect(JSON.parse(req!.body!)).toMatchObject({
      eventType: 'INCIDENT_CREATED',
      deliveryId: repo.notificationDeliveries[0]!.id,
    });
    expect(repo.notificationDeliveries[0]!.status).toBe('SENT');
  });

  it('retries temporary failures with exponential backoff, then marks FAILED after the maximum', async () => {
    await openIncident({ webhook: { enabled: true, url: webhookUrl } });
    const d = repo.notificationDeliveries[0]!;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      target.reply('/rain', 'POST', 503);
      expect(await dispatcher().pollOnce()).toBe(1);
      if (attempt < 8) {
        expect(d.status).toBe('PENDING');
        delays.push(d.nextAttemptAt.getTime() - clock);
        // Not due yet: nothing is claimed early.
        expect(await dispatcher().pollOnce()).toBe(0);
        clock = d.nextAttemptAt.getTime();
      }
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000]);
    expect(d).toMatchObject({ status: 'FAILED', attempts: 8 });
    expect(d.lastError).toBe(
      'Webhook hooks.example.com answered HTTP 503 (gave up after 8 attempts)',
    );
    expect(repo.notificationAttempts.filter((a) => a.deliveryId === d.id)).toHaveLength(8);
    expect(await dispatcher().pollOnce()).toBe(0);
  });

  it('permanent failures stop at once', async () => {
    await openIncident({ webhook: { enabled: true, url: webhookUrl } });
    target.reply('/rain', 'POST', 410);
    await dispatcher().pollOnce();
    expect(repo.notificationDeliveries[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
  });

  it('SSRF: a webhook host resolving to a private address is never contacted', async () => {
    await openIncident({ webhook: { enabled: true, url: webhookUrl } });
    target.setDnsAnswers([{ address: '192.168.1.10', family: 4 }]);
    await dispatcher().pollOnce();
    expect(repo.notificationDeliveries[0]).toMatchObject({
      status: 'FAILED',
      lastError: 'Webhook hooks.example.com: the destination is not allowed',
    });
    expect(target.captured).toHaveLength(0);
  });

  it('recovers a delivery whose worker died mid-attempt (lease expiry), and ignores the stale result', async () => {
    await openIncident({ emailEnabled: true });
    const [stale] = await dispatch.claim(10, 60);
    expect(await dispatch.claim(10, 60)).toHaveLength(0); // Live lease.
    clock += 61_000;
    await dispatcher().pollOnce();
    const d = repo.notificationDeliveries[0]!;
    expect(d).toMatchObject({ status: 'SENT', attempts: 2 });
    const lateResult = await dispatch.complete(stale!, {
      startedAt: now(),
      finishedAt: now(),
      result: { outcome: 'PERMANENT_FAILURE', httpStatus: null, error: 'late' },
      decision: { status: 'FAILED', nextAttemptAt: now(), lastError: 'late' },
    });
    expect(lateResult).toBe(false);
    expect(d.status).toBe('SENT');
  });

  it('an expired lease with no attempts left becomes FAILED, not retried', async () => {
    await openIncident({ emailEnabled: true });
    const d = repo.notificationDeliveries[0]!;
    d.maxAttempts = 1;
    await dispatch.claim(10, 60);
    clock += 61_000;
    expect(await dispatch.claim(10, 60)).toHaveLength(0);
    expect(d).toMatchObject({
      status: 'FAILED',
      lastError: expect.stringMatching(/did not complete/),
    });
  });

  it('a webhook removed after queueing fails permanently instead of sending to an old address', async () => {
    const { monitor } = await openIncident({ webhook: { enabled: true, url: webhookUrl } });
    await configure(monitor.id, { webhook: null });
    await dispatcher().pollOnce();
    expect(repo.notificationDeliveries[0]).toMatchObject({
      status: 'FAILED',
      lastError: expect.stringMatching(/removed or disabled/),
    });
    expect(target.captured).toHaveLength(0);
  });

  it('without an email provider, emails fail visibly instead of pretending to be sent', async () => {
    await openIncident({ emailEnabled: true });
    const { UNCONFIGURED_EMAIL_PROVIDER } = await import('./email.js');
    await dispatcher(UNCONFIGURED_EMAIL_PROVIDER).pollOnce();
    expect(repo.notificationDeliveries[0]).toMatchObject({
      status: 'FAILED',
      lastError: expect.stringMatching(/not configured/),
    });
  });

  it('keeps polling after a database error and drains in-flight work on stop', async () => {
    await openIncident({ emailEnabled: true });
    dispatch.failNext('claim');
    const d = createNotificationDispatcher({
      store: dispatch,
      email: fakeEmail,
      webhook: createWebhookSender({
        transport: { kind: 'dispatcher', dispatcher: target.dispatcher },
      }),
      secretBox,
      logger: pino({ level: 'silent' }),
      appBaseUrl: 'https://rain.example.com',
      now,
      settings: { pollIntervalMs: 50, maxBackoffMs: 200 },
    });
    d.start();
    const deadline = Date.now() + 3000;
    while (repo.notificationDeliveries[0]!.status !== 'SENT' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(repo.notificationDeliveries[0]!.status).toBe('SENT');
    expect(await d.stop(1000)).toEqual({ drained: true, abandoned: 0 });
  });
});

describe('settings and history service', () => {
  it('defaults to nothing enabled and reports the email address and provider state', async () => {
    const m = await createMonitor();
    expect(await notifications.getSettings(owner, OWNER_EMAIL, m.id)).toEqual({
      monitorId: m.id,
      email: { enabled: false, address: OWNER_EMAIL, providerConfigured: true },
      webhook: null,
    });
  });

  it('creates a webhook with a signing secret shown once and stored only encrypted', async () => {
    const m = await createMonitor();
    const created = await configure(m.id, {
      webhook: {
        enabled: true,
        url: webhookUrl,
        header: { name: 'Authorization', value: 'Bearer hook-token' },
      },
    });
    expect(created.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.settings.webhook).toMatchObject({
      enabled: true,
      url: webhookUrl,
      headerName: 'Authorization',
    });
    const stored = repo.notificationSettings[0]!;
    expect(JSON.stringify(stored)).not.toContain(created.signingSecret!);
    expect(JSON.stringify(stored)).not.toContain('hook-token');
    const read = await notifications.getSettings(owner, OWNER_EMAIL, m.id);
    expect(JSON.stringify(read)).not.toContain('whsec_');
    expect(JSON.stringify(read)).not.toContain('hook-token');

    // Updating without rotation keeps the secret (none returned); rotation returns a new one.
    const toggled = await configure(m.id, { webhook: { enabled: false, url: webhookUrl } });
    expect(toggled.signingSecret).toBeNull();
    expect(toggled.settings.webhook!.headerName).toBe('Authorization');
    const rotated = await configure(m.id, {
      webhook: { enabled: true, url: webhookUrl, rotateSecret: true },
    });
    expect(rotated.signingSecret).toMatch(/^whsec_/);
    expect(rotated.signingSecret).not.toBe(created.signingSecret);
  });

  it('drops a stored header when the webhook moves to another origin', async () => {
    const m = await createMonitor();
    await configure(m.id, {
      webhook: {
        enabled: true,
        url: webhookUrl,
        header: { name: 'Authorization', value: 'x-token' },
      },
    });
    const moved = await configure(m.id, {
      webhook: { enabled: true, url: 'https://other.example.org/hook' },
    });
    expect(moved.settings.webhook!.headerName).toBeNull();
    const same = await configure(m.id, {
      webhook: {
        enabled: true,
        url: 'https://other.example.org/hook2',
        header: { name: 'X-Key', value: 'k' },
      },
    });
    expect(same.settings.webhook!.headerName).toBe('X-Key');
  });

  it('removes a webhook with its secret and header', async () => {
    const m = await createMonitor();
    await configure(m.id, {
      webhook: { enabled: true, url: webhookUrl, header: { name: 'X-Key', value: 'k' } },
    });
    const removed = await configure(m.id, { webhook: null });
    expect(removed.settings.webhook).toBeNull();
    expect(repo.notificationSettings[0]).toMatchObject({
      webhookUrl: null,
      webhookSecretCiphertext: null,
      webhookHeaderName: null,
    });
  });

  it("is owner-scoped: settings, history, details and retry of another user's data are 404", async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    const id = repo.notificationDeliveries[0]!.id;
    const codes = await Promise.all([
      notifications.getSettings(stranger, null, m.id).catch((e: AppError) => e.code),
      notifications
        .updateSettings(stranger, null, m.id, { emailEnabled: true })
        .catch((e: AppError) => e.code),
      notifications.get(stranger, id).catch((e: AppError) => e.code),
      notifications.retry(stranger, id).catch((e: AppError) => e.code),
    ]);
    expect(codes).toEqual([
      'MONITOR_NOT_FOUND',
      'MONITOR_NOT_FOUND',
      'NOTIFICATION_NOT_FOUND',
      'NOTIFICATION_NOT_FOUND',
    ]);
    expect((await notifications.list(stranger, { limit: 25 })).total).toBe(0);
  });

  it('lists newest first with filters and pagination', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true, webhook: { enabled: true, url: webhookUrl } });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    await runCheck(m.id, success());
    await runCheck(m.id, success());
    const all = await notifications.list(owner, { limit: 25 });
    expect(all.total).toBe(4);
    expect(all.items[0]!.eventType).toBe('INCIDENT_RESOLVED');
    expect((await notifications.list(owner, { limit: 25, channel: 'WEBHOOK' })).total).toBe(2);
    expect((await notifications.list(owner, { limit: 25, status: 'SENT' })).total).toBe(0);
    expect((await notifications.list(owner, { limit: 25, monitorId: m.id })).total).toBe(4);
    const first = await notifications.list(owner, { limit: 3 });
    const second = await notifications.list(owner, { limit: 3, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(4);
    expect(JSON.stringify(all)).not.toMatch(/ciphertext|lease|payload/);
  });

  it('retries only FAILED deliveries, with a fresh budget and history kept', async () => {
    const m = await createMonitor();
    await configure(m.id, { emailEnabled: true });
    await runCheck(m.id, failure());
    await runCheck(m.id, failure());
    const id = repo.notificationDeliveries[0]!.id;
    await expect(notifications.retry(owner, id)).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_RETRYABLE',
    });
    emailResults.push({
      outcome: 'PERMANENT_FAILURE',
      httpStatus: 422,
      error: 'Email provider answered HTTP 422',
    });
    await dispatcher().pollOnce();
    const retried = await notifications.retry(owner, id);
    expect(retried).toMatchObject({ status: 'PENDING', attempts: 1, maxAttempts: 9 });
    await dispatcher().pollOnce();
    const done = await notifications.get(owner, id);
    expect(done.status).toBe('SENT');
    expect(done.attemptHistory.map((a) => [a.attemptNumber, a.outcome])).toEqual([
      [1, 'PERMANENT_FAILURE'],
      [2, 'SUCCESS'],
    ]);
    await expect(notifications.retry(owner, id)).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_RETRYABLE',
    });
  });
});
