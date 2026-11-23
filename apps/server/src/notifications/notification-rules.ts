import {
  NOTIFICATION_LIMITS,
  type IncidentSeverity,
  type IncidentStatus,
  type NotificationChannel,
  type NotificationEventType,
  type NotificationPayload,
} from '@rain/shared';
import type { MonitorNotificationSettingsRow, NewNotificationDeliveryRow } from '../db/schema.js';

/**
 * Pure notification rules: what to queue for an incident event, how to describe destinations,
 * and how to retry. No I/O; used inside the incident transaction and by the dispatcher.
 */

export interface IncidentEventSnapshot {
  eventId: string;
  eventType: NotificationEventType;
  occurredAt: Date;
  incident: {
    id: string;
    title: string;
    severity: IncidentSeverity;
    status: IncidentStatus;
    summary: string;
    startedAt: Date;
    resolvedAt: Date | null;
  };
  monitor: { id: string; name: string };
  ownerId: string;
}

export function buildPayload(e: IncidentEventSnapshot): NotificationPayload {
  return {
    eventId: e.eventId,
    eventType: e.eventType,
    occurredAt: e.occurredAt.toISOString(),
    incident: {
      ...e.incident,
      startedAt: e.incident.startedAt.toISOString(),
      resolvedAt: e.incident.resolvedAt?.toISOString() ?? null,
    },
    monitor: e.monitor,
  };
}

/** "p•••@example.com": enough to recognise, not enough to harvest. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${address[0]}•••${address.slice(at)}`;
}

/** Only the host of a webhook URL is ever shown or logged (no path, query or credentials). */
export function webhookDestination(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? parsed.host : 'invalid URL';
}

/** The channels that are both enabled and configured for this event. */
export function planDeliveries(
  settings: MonitorNotificationSettingsRow | undefined,
  ownerEmail: string | null,
  event: IncidentEventSnapshot,
): NewNotificationDeliveryRow[] {
  if (!settings) return [];
  const base = {
    ownerId: event.ownerId,
    monitorId: event.monitor.id,
    incidentId: event.incident.id,
    eventId: event.eventId,
    eventType: event.eventType,
    payload: buildPayload(event),
    status: 'PENDING' as const,
    nextAttemptAt: event.occurredAt,
  };
  const rows: NewNotificationDeliveryRow[] = [];
  if (settings.emailEnabled && ownerEmail) {
    rows.push({ ...base, channel: 'EMAIL', destination: maskEmail(ownerEmail) });
  }
  if (settings.webhookEnabled && settings.webhookUrl && settings.webhookSecretCiphertext) {
    rows.push({
      ...base,
      channel: 'WEBHOOK',
      destination: webhookDestination(settings.webhookUrl),
    });
  }
  return rows;
}

// --- Retries --------------------------------------------------------------------------------------

export const RETRY_POLICY = {
  baseDelayMs: 30_000,
  maxDelayMs: 6 * 3600_000,
} as const;

/**
 * Delay before the next attempt after `attempt` failed attempts (1-based): exponential
 * (30 s, 1 min, 2 min, … capped at 6 h) with "equal jitter": half fixed, half random, so retries
 * from many deliveries spread out while each still waits at least half the nominal delay.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const nominal = Math.min(
    RETRY_POLICY.maxDelayMs,
    RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(nominal / 2 + random() * (nominal / 2));
}

export type DeliveryResult =
  | { outcome: 'SUCCESS'; httpStatus: number | null }
  | {
      outcome: 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE';
      httpStatus: number | null;
      /** Sanitised: safe to store and show. */
      error: string;
    };

/** HTTP status → retry decision, for both webhooks and the email provider's API. */
export function classifyHttpStatus(
  status: number,
): 'SUCCESS' | 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE' {
  if (status >= 200 && status < 300) return 'SUCCESS';
  // Timeouts, rate limits and server errors may pass; anything else won't by retrying.
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return 'TEMPORARY_FAILURE';
  return 'PERMANENT_FAILURE';
}

export type CompletionDecision =
  | { status: 'SENT'; deliveredAt: Date; nextAttemptAt: Date; lastError: null }
  | { status: 'PENDING'; nextAttemptAt: Date; lastError: string }
  | { status: 'FAILED'; nextAttemptAt: Date; lastError: string };

/** What a delivery becomes after an attempt. `attempts` already includes this attempt. */
export function decideAfterAttempt(
  result: DeliveryResult,
  attempts: number,
  maxAttempts: number,
  now: Date,
  random: () => number = Math.random,
): CompletionDecision {
  if (result.outcome === 'SUCCESS') {
    return { status: 'SENT', deliveredAt: now, nextAttemptAt: now, lastError: null };
  }
  const error = result.error.slice(0, NOTIFICATION_LIMITS.errorMaxLength);
  if (result.outcome === 'PERMANENT_FAILURE' || attempts >= maxAttempts) {
    const exhausted =
      result.outcome === 'TEMPORARY_FAILURE' ? ` (gave up after ${attempts} attempts)` : '';
    return {
      status: 'FAILED',
      nextAttemptAt: now,
      lastError: `${error}${exhausted}`.slice(0, NOTIFICATION_LIMITS.errorMaxLength),
    };
  }
  return {
    status: 'PENDING',
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts, random)),
    lastError: error,
  };
}

export const channelLabel = (c: NotificationChannel) => (c === 'EMAIL' ? 'email' : 'webhook');
