import type { NotificationPayload } from '@rain/shared';
import { Agent, request, type Dispatcher } from 'undici';
import { classifyHttpStatus, type DeliveryResult } from './notification-rules.js';

/**
 * Email delivery behind a small provider interface. The only adapter is Resend's REST API, called
 * directly (no SDK dependency). Its endpoint is fixed by RAIN, not user input, so it does not go
 * through the SSRF-safe transport (which is for user-chosen destinations); it uses its own
 * dedicated client with TLS verification on.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Sent as the provider's idempotency key: retries of one delivery can't create two emails. */
  idempotencyKey: string;
}

export interface EmailProvider {
  readonly configured: boolean;
  send(message: EmailMessage): Promise<DeliveryResult>;
}

/** Used when no provider is configured: every email fails visibly instead of pretending. */
export const UNCONFIGURED_EMAIL_PROVIDER: EmailProvider = {
  configured: false,
  send: async () => ({
    outcome: 'PERMANENT_FAILURE',
    httpStatus: null,
    error:
      'Email delivery is not configured on this RAIN server (RESEND_API_KEY and NOTIFICATION_EMAIL_FROM)',
  }),
};

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const EMAIL_TIMEOUT_MS = 15_000;

export function createResendProvider(options: {
  apiKey: string;
  from: string;
  /** For tests (a MockAgent); defaults to a dedicated Agent. */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}): EmailProvider {
  const dispatcher = options.dispatcher ?? new Agent({ connect: { rejectUnauthorized: true } });
  const timeoutMs = options.timeoutMs ?? EMAIL_TIMEOUT_MS;

  return {
    configured: true,
    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(RESEND_ENDPOINT, {
          dispatcher,
          method: 'POST',
          signal: controller.signal,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': message.idempotencyKey,
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
        });
        // Only a short machine-readable error name is kept; never the raw provider response.
        const raw = await response.body.text().catch(() => '');
        const outcome = classifyHttpStatus(response.statusCode);
        if (outcome === 'SUCCESS') return { outcome, httpStatus: response.statusCode };
        let name = '';
        try {
          const parsed = JSON.parse(raw) as { name?: unknown };
          if (typeof parsed.name === 'string' && /^[a-z_]{1,40}$/.test(parsed.name)) {
            name = ` (${parsed.name})`;
          }
        } catch {
          // Not JSON: ignore.
        }
        return {
          outcome,
          httpStatus: response.statusCode,
          error: `Email provider answered HTTP ${response.statusCode}${name}`,
        };
      } catch {
        return {
          outcome: 'TEMPORARY_FAILURE',
          httpStatus: null,
          error: 'Could not reach the email provider',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }) + ' UTC';

/** Subject, HTML and plain text for an incident notification. Every value is escaped. */
export function renderIncidentEmail(
  payload: NotificationPayload,
  appBaseUrl: string,
): { subject: string; html: string; text: string } {
  const opened = payload.eventType === 'INCIDENT_CREATED';
  const { incident, monitor } = payload;
  const link = `${appBaseUrl.replace(/\/+$/, '')}/app/incidents/${encodeURIComponent(incident.id)}`;
  const heading = opened ? `Incident opened: ${incident.title}` : `Resolved: ${incident.title}`;
  const rows: Array<[string, string]> = [
    ['Monitor', monitor.name],
    ['Incident', incident.title],
    ['Severity', incident.severity],
    ['Status', incident.status],
    [opened ? 'Started' : 'Resolved', dateTime(payload.occurredAt)],
    ...(opened ? [] : ([['Started', dateTime(incident.startedAt)]] as Array<[string, string]>)),
  ];
  const accent = opened ? '#d95926' : '#3987e5';

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1f24">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border-top:4px solid ${accent}">
<tr><td style="padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5b6470">RAIN API Observatory</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#5b6470;width:120px">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`).join('\n')}
</table>
<p style="margin:16px 0;font-size:14px;line-height:1.5">${escapeHtml(incident.summary)}</p>
<p style="margin:24px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:${accent};color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px">View incident</a></p>
</td></tr></table>
<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#5b6470">You receive this because email notifications are enabled for this monitor in RAIN.</p>
</body></html>`;

  const text = [
    heading,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    incident.summary,
    '',
    `View incident: ${link}`,
    '',
    'You receive this because email notifications are enabled for this monitor in RAIN.',
  ].join('\n');

  return { subject: `[RAIN] ${heading}`, html, text };
}
