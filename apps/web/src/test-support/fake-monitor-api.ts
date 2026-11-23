/**
 * TEST AND UI-HARNESS ONLY. An in-memory stand-in for the RAIN monitor API, exposed as a `fetch`
 * function. It validates requests with the same shared schemas as the real server and follows the
 * same origin-change and header rules, so UI tests exercise realistic responses. It is not the
 * server: backend behaviour is verified by the server's own unit and integration tests.
 * Nothing in the production app imports this module.
 */
import {
  AddStatusPageMonitorSchema,
  CreateStatusPageSchema,
  ReorderStatusPageMonitorsSchema,
  UpdateStatusPageMonitorSchema,
  UpdateStatusPageSchema,
  CreateMonitorSchema,
  NotificationListQuerySchema,
  UpdateNotificationSettingsSchema,
  IncidentEventListQuerySchema,
  IncidentListQuerySchema,
  UpdateIncidentSchema,
  MONITOR_LIMITS,
  MonitorHeaderUpdateSchema,
  MonitorCheckListQuerySchema,
  MonitorListQuerySchema,
  UpdateMonitorSchema,
  findMonitorConfigIssues,
  monitorOrigin,
  resolveBodyContentType,
  type AnalyticsOverview,
  type AnalyticsRange,
  type ApiFieldIssue,
  type MonitorMetrics,
  type PublicStatusPage,
  type StatusPage,
  type NotificationDeliveryDetail,
  type NotificationSettings,
  type Incident,
  type IncidentEvent,
  type Monitor,
  type MonitorCheck,
  type MonitorStatus,
} from '@rain/shared';
import type { ZodError } from 'zod';
import { makeMonitorMetrics, makeOverview } from './analytics-fixtures';

interface StoredMonitor extends Omit<Monitor, 'headers'> {
  /** Header values are kept only so tests can assert what the "server" received. */
  headers: Array<{ name: string; value: string; updatedAt: string }>;
}

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

type Override = { status: number; body?: unknown } | 'network-error';

const json = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

const error = (status: number, code: string, message: string, details?: ApiFieldIssue[]) =>
  json(status, {
    error: { code, message, requestId: 'fake-request', ...(details && { details }) },
  });

function validationError(err: ZodError) {
  const details: ApiFieldIssue[] = err.issues.map((i) => {
    const code = (i as { params?: { code?: string } }).params?.code;
    return { path: i.path.join('.'), message: i.message, ...(code && { code }) };
  });
  const [only] = details;
  return details.length === 1 && only?.code === 'UNSUPPORTED_PORT'
    ? error(400, 'UNSUPPORTED_PORT', only.message, details)
    : error(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

export interface FakeMonitorApi {
  fetch: typeof fetch;
  requests: FakeRequest[];
  monitors: Map<string, StoredMonitor>;
  /** Recorded checks per monitor, newest first. */
  checks: Map<string, MonitorCheck[]>;
  /** Adds a recorded check, as if the worker had run it, and updates the monitor's health fields. */
  recordCheck(
    monitorId: string,
    check: Partial<MonitorCheck> & Pick<MonitorCheck, 'outcome'>,
    health?: { currentStatus?: MonitorStatus },
  ): MonitorCheck;
  /** Completes the queued manual check for this monitor, like the worker would. */
  completeManualCheck(
    monitorId: string,
    check: Partial<MonitorCheck> & Pick<MonitorCheck, 'outcome'>,
    health?: { currentStatus?: MonitorStatus },
  ): MonitorCheck;
  /** Adds a monitor directly, as if created earlier. Returns it as the API would. */
  seed(overrides?: Partial<StoredMonitor> & { name: string }): Monitor;
  /** The next request matching method and path pattern gets this response instead. */
  failNext(method: string, path: RegExp, response: Override): void;
  /** Delays every response by this many milliseconds (to observe loading states). */
  latencyMs: number;
  quotaLimit: number;
  /** Incidents and their timelines, as the worker and owner would have made them. */
  incidents: Incident[];
  incidentEvents: Map<string, IncidentEvent[]>;
  /** Adds an incident for a seeded monitor, with an INCIDENT_CREATED event. */
  seedIncident(monitorId: string, overrides?: Partial<Incident>): Incident;
  /**
   * Analytics responses by range (and by monitor). Unset ranges answer "nothing recorded",
   * with monitor counts taken from the seeded monitors.
   */
  /** Notification settings by monitor (webhook header values kept only to assert on). */
  notificationSettings: Map<
    string,
    {
      emailEnabled: boolean;
      webhook: {
        enabled: boolean;
        url: string;
        headerName: string | null;
        headerValue: string | null;
        updatedAt: string;
      } | null;
    }
  >;
  /** The signed-in user's address and whether the "server" has an email provider. */
  emailAddress: string | null;
  emailProviderConfigured: boolean;
  deliveries: NotificationDeliveryDetail[];
  seedDelivery(
    overrides: Partial<NotificationDeliveryDetail> &
      Pick<NotificationDeliveryDetail, 'monitor' | 'incident'>,
  ): NotificationDeliveryDetail;
  /** Status pages (config as the owner API returns it). */
  statusPages: StatusPage[];
  seedStatusPage(overrides: Partial<StatusPage> & { title: string; slug: string }): StatusPage;
  analytics: {
    overview: Partial<Record<AnalyticsRange, AnalyticsOverview>>;
    metrics: Map<string, Partial<Record<AnalyticsRange, MonitorMetrics>>>;
  };
}

export function createFakeMonitorApi(options: { quotaLimit?: number } = {}): FakeMonitorApi {
  const monitors = new Map<string, StoredMonitor>();
  const checks = new Map<string, MonitorCheck[]>();
  const requests: FakeRequest[] = [];
  const overrides: Array<{ method: string; path: RegExp; response: Override }> = [];
  let clock = Date.parse('2026-11-17T09:00:00.000Z');
  let sequence = 0;
  const tick = () => new Date((clock += 1000)).toISOString();

  const view = (m: StoredMonitor): Monitor => ({
    ...m,
    nextCheckAt: m.enabled ? m.nextCheckAt : null,
    headers: m.headers
      .map(({ name, updatedAt }) => ({ name, configured: true as const, updatedAt }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
  });
  const summary = (m: StoredMonitor) => {
    const { requestBody: _b, bodyContentType: _c, headers: _h, ...rest } = view(m);
    return rest;
  };

  function seed(overrides: Partial<StoredMonitor> & { name: string }): Monitor {
    const now = tick();
    const id = overrides.id ?? `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    const monitor: StoredMonitor = {
      id,
      description: null,
      url: 'https://api.example.com/health',
      method: 'GET',
      expectedStatusCode: 200,
      timeoutMs: MONITOR_LIMITS.timeoutMs.default,
      latencyThresholdMs: MONITOR_LIMITS.latencyThresholdMs.default,
      checkIntervalSeconds: MONITOR_LIMITS.checkIntervalSeconds.default,
      enabled: true,
      currentStatus: 'UNKNOWN',
      lastCheckedAt: null,
      nextCheckAt: now,
      createdAt: now,
      updatedAt: now,
      requestBody: null,
      bodyContentType: null,
      allowMutatingRequests: false,
      statusChangedAt: null,
      manualCheckQueuedAt: null,
      lastManualCheckAt: null,
      headers: [],
      ...overrides,
    };
    monitors.set(id, monitor);
    return view(monitor);
  }

  const OWNER = '11111111-1111-4111-8111-111111111111';
  const incidentView = (i: Incident): Incident => {
    const m = monitors.get(i.monitor.id);
    return m
      ? {
          ...i,
          monitor: { id: m.id, name: m.name, currentStatus: m.currentStatus, enabled: m.enabled },
        }
      : i;
  };
  const addEvent = (incidentId: string, event: Omit<IncidentEvent, 'id'>) => {
    const list = fake.incidentEvents.get(incidentId) ?? [];
    list.push({ id: `00000000-0000-4000-a000-${String(++sequence).padStart(12, '0')}`, ...event });
    fake.incidentEvents.set(incidentId, list);
  };

  function seedIncident(monitorId: string, overrides: Partial<Incident> = {}): Incident {
    const m = monitors.get(monitorId);
    if (!m) throw new Error('No monitor ' + monitorId);
    const startedAt = overrides.startedAt ?? tick();
    const incident: Incident = {
      id: `00000000-0000-4000-b000-${String(++sequence).padStart(12, '0')}`,
      monitor: { id: m.id, name: m.name, currentStatus: m.currentStatus, enabled: m.enabled },
      title: m.name + ' is down',
      description:
        'Detected automatically after 2 consecutive failed checks. Last check: timed out.',
      severity: 'HIGH',
      status: 'OPEN',
      startedAt,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      triggerCheckId: null,
      resolvedByCheckId: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      ...overrides,
    };
    fake.incidents.push(incident);
    addEvent(incident.id, {
      type: 'INCIDENT_CREATED',
      occurredAt: startedAt,
      actor: 'SYSTEM',
      actorId: null,
      description:
        'Incident opened: the monitor went DOWN after 2 consecutive failed checks (last check: timed out).',
      checkId: null,
    });
    if (incident.resolvedAt) {
      addEvent(incident.id, {
        type: 'INCIDENT_RESOLVED',
        occurredAt: incident.resolvedAt,
        actor: 'SYSTEM',
        actorId: null,
        description: 'Resolved automatically after 2 consecutive successful checks.',
        checkId: null,
      });
    }
    return incidentView(incident);
  }

  function handleIncidents(method: string, url: URL, body: unknown): Response | undefined {
    const path = url.pathname;
    if (path === '/api/v1/incidents' && method === 'GET') {
      const query = IncidentListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return validationError(query.error);
      const { status, severity, monitorId, limit, cursor } = query.data;
      const all = [...fake.incidents]
        .filter(
          (i) =>
            (!status || (status === 'ACTIVE' ? i.status !== 'RESOLVED' : i.status === status)) &&
            (!severity || i.severity === severity) &&
            (!monitorId || i.monitor.id === monitorId),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
      const start = cursor ? all.findIndex((i) => i.id === atob(cursor)) + 1 : 0;
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      return json(200, {
        data: {
          items: page.map(incidentView),
          nextCursor: start + limit < all.length && last ? btoa(last.id) : null,
          total: all.length,
        },
      });
    }
    if (path === '/api/v1/incidents/counts' && method === 'GET') {
      const monitorId = url.searchParams.get('monitorId');
      const mine = fake.incidents.filter((i) => !monitorId || i.monitor.id === monitorId);
      const of = (st: string) => mine.filter((i) => i.status === st).length;
      return json(200, {
        data: {
          total: mine.length,
          open: of('OPEN'),
          acknowledged: of('ACKNOWLEDGED'),
          resolved: of('RESOLVED'),
        },
      });
    }
    const match = /^\/api\/v1\/incidents\/([^/]+)(\/events|\/acknowledge)?$/.exec(path);
    if (!match) return undefined;
    const incident = fake.incidents.find((i) => i.id === decodeURIComponent(match[1]!));
    if (!incident) return error(404, 'INCIDENT_NOT_FOUND', 'Incident not found');
    const action = match[2];
    if (!action && method === 'GET') return json(200, { data: incidentView(incident) });
    if (action === '/events' && method === 'GET') {
      const query = IncidentEventListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return validationError(query.error);
      const all = fake.incidentEvents.get(incident.id) ?? [];
      const cursor = query.data.cursor;
      const start = cursor ? all.findIndex((e) => e.id === atob(cursor)) + 1 : 0;
      const page = all.slice(start, start + query.data.limit);
      const last = page.at(-1);
      return json(200, {
        data: {
          items: page,
          nextCursor: start + query.data.limit < all.length && last ? btoa(last.id) : null,
        },
      });
    }
    if (action === '/acknowledge' && method === 'POST') {
      if (incident.status === 'RESOLVED') {
        return error(
          409,
          'INCIDENT_ALREADY_RESOLVED',
          'This incident is already resolved and can no longer be acknowledged.',
        );
      }
      if (incident.status === 'ACKNOWLEDGED') {
        return error(
          409,
          'INCIDENT_ALREADY_ACKNOWLEDGED',
          'This incident has already been acknowledged.',
        );
      }
      const at = tick();
      Object.assign(incident, {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: at,
        acknowledgedBy: OWNER,
        updatedAt: at,
      });
      addEvent(incident.id, {
        type: 'INCIDENT_ACKNOWLEDGED',
        occurredAt: at,
        actor: 'USER',
        actorId: OWNER,
        description: 'Incident acknowledged by the monitor owner.',
        checkId: null,
      });
      return json(200, { data: incidentView(incident) });
    }
    if (!action && method === 'PATCH') {
      const parsed = UpdateIncidentSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      const at = tick();
      const parts: string[] = [];
      if (parsed.data.severity && parsed.data.severity !== incident.severity) {
        parts.push('Severity changed from ' + incident.severity + ' to ' + parsed.data.severity);
      }
      if (parsed.data.title !== undefined && parsed.data.title !== incident.title) {
        parts.push('Title changed');
      }
      if (
        parsed.data.description !== undefined &&
        parsed.data.description !== incident.description
      ) {
        parts.push(
          parsed.data.description === null ? 'Description removed' : 'Description updated',
        );
      }
      Object.assign(incident, parsed.data, { updatedAt: at });
      if (parts.length) {
        addEvent(incident.id, {
          type: 'INCIDENT_UPDATED',
          occurredAt: at,
          actor: 'USER',
          actorId: OWNER,
          description: parts.join('. ') + '.',
          checkId: null,
        });
      }
      return json(200, { data: incidentView(incident) });
    }
    return error(404, 'NOT_FOUND', 'No route for ' + method + ' ' + path);
  }

  const RANGES = ['24h', '7d', '30d'];
  function handleAnalytics(method: string, url: URL): Response | undefined {
    if (method !== 'GET') return undefined;
    const range = (url.searchParams.get('range') ?? '24h') as AnalyticsRange;
    const invalid = () =>
      error(400, 'VALIDATION_ERROR', 'Request validation failed', [
        { path: 'range', message: 'Invalid option' },
      ]);
    if (url.pathname === '/api/v1/analytics/overview') {
      if (!RANGES.includes(range)) return invalid();
      const all = [...monitors.values()];
      const on = (st: string) => all.filter((m) => m.enabled && m.currentStatus === st).length;
      return json(200, {
        data:
          fake.analytics.overview[range] ??
          makeOverview(range, {
            monitors: {
              total: all.length,
              healthy: on('HEALTHY'),
              degraded: on('DEGRADED'),
              down: on('DOWN'),
              unknown: on('UNKNOWN'),
              paused: all.filter((m) => !m.enabled).length,
            },
          }),
      });
    }
    const match = /^\/api\/v1\/monitors\/([^/]+)\/metrics$/.exec(url.pathname);
    if (!match) return undefined;
    const monitor = monitors.get(decodeURIComponent(match[1]!));
    if (!monitor) return error(404, 'MONITOR_NOT_FOUND', 'Monitor not found');
    if (!RANGES.includes(range)) return invalid();
    const ref = {
      id: monitor.id,
      name: monitor.name,
      currentStatus: monitor.currentStatus,
      enabled: monitor.enabled,
    };
    return json(200, {
      data: fake.analytics.metrics.get(monitor.id)?.[range] ?? makeMonitorMetrics(range, ref),
    });
  }

  function settingsView(monitorId: string): NotificationSettings {
    const stored = fake.notificationSettings.get(monitorId);
    return {
      monitorId,
      email: {
        enabled: stored?.emailEnabled ?? false,
        address: fake.emailAddress,
        providerConfigured: fake.emailProviderConfigured,
      },
      webhook: stored?.webhook
        ? {
            enabled: stored.webhook.enabled,
            url: stored.webhook.url,
            headerName: stored.webhook.headerName,
            updatedAt: stored.webhook.updatedAt,
          }
        : null,
    };
  }

  function seedDelivery(
    overrides: Partial<NotificationDeliveryDetail> &
      Pick<NotificationDeliveryDetail, 'monitor' | 'incident'>,
  ): NotificationDeliveryDetail {
    const createdAt = tick();
    const delivery: NotificationDeliveryDetail = {
      id: '00000000-0000-4000-b100-' + String(++sequence).padStart(12, '0'),
      eventType: 'INCIDENT_CREATED',
      channel: 'EMAIL',
      status: 'SENT',
      destination: 'h•••@example.com',
      attempts: 1,
      maxAttempts: 8,
      createdAt,
      nextAttemptAt: null,
      lastAttemptedAt: createdAt,
      deliveredAt: createdAt,
      lastError: null,
      attemptHistory: [],
      ...overrides,
    };
    fake.deliveries.push(delivery);
    return delivery;
  }

  function handleNotifications(method: string, url: URL, body: unknown): Response | undefined {
    const path = url.pathname;
    const settingsMatch = /^\/api\/v1\/monitors\/([^/]+)\/notifications$/.exec(path);
    if (settingsMatch) {
      const monitorId = decodeURIComponent(settingsMatch[1]!);
      if (!monitors.has(monitorId)) return error(404, 'MONITOR_NOT_FOUND', 'Monitor not found');
      if (method === 'GET') return json(200, { data: settingsView(monitorId) });
      if (method === 'PUT') {
        const parsed = UpdateNotificationSettingsSchema.safeParse(body);
        if (!parsed.success) return validationError(parsed.error);
        const patch = parsed.data;
        const current = fake.notificationSettings.get(monitorId) ?? {
          emailEnabled: false,
          webhook: null,
        };
        let signingSecret: string | null = null;
        const next = { ...current };
        if (patch.emailEnabled !== undefined) next.emailEnabled = patch.emailEnabled;
        if (patch.webhook === null) next.webhook = null;
        else if (patch.webhook) {
          if (!current.webhook || patch.webhook.rotateSecret) {
            signingSecret = 'whsec_fake' + String(++sequence).padStart(38, '0');
          }
          const keep = patch.webhook.header === undefined ? current.webhook : null;
          next.webhook = {
            enabled: patch.webhook.enabled,
            url: patch.webhook.url,
            headerName: patch.webhook.header?.name ?? keep?.headerName ?? null,
            headerValue: patch.webhook.header?.value ?? keep?.headerValue ?? null,
            updatedAt: tick(),
          };
        }
        fake.notificationSettings.set(monitorId, next);
        return json(200, { data: { settings: settingsView(monitorId), signingSecret } });
      }
    }
    if (path === '/api/v1/notifications' && method === 'GET') {
      const query = NotificationListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return validationError(query.error);
      const { status, channel, monitorId, limit, cursor } = query.data;
      const all = [...fake.deliveries]
        .filter(
          (d) =>
            (!status || d.status === status) &&
            (!channel || d.channel === channel) &&
            (!monitorId || d.monitor.id === monitorId),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const start = cursor ? all.findIndex((d) => d.id === atob(cursor)) + 1 : 0;
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      return json(200, {
        data: {
          items: page.map(({ attemptHistory: _a, ...d }) => d),
          nextCursor: start + limit < all.length && last ? btoa(last.id) : null,
          total: all.length,
        },
      });
    }
    const match = /^\/api\/v1\/notifications\/([^/]+)(\/retry)?$/.exec(path);
    if (!match) return undefined;
    const delivery = fake.deliveries.find((d) => d.id === decodeURIComponent(match[1]!));
    if (!delivery) return error(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
    if (!match[2] && method === 'GET') return json(200, { data: delivery });
    if (match[2] && method === 'POST') {
      if (delivery.status !== 'FAILED') {
        return error(409, 'NOTIFICATION_NOT_RETRYABLE', 'This notification was already delivered.');
      }
      Object.assign(delivery, {
        status: 'PENDING',
        nextAttemptAt: tick(),
        maxAttempts: delivery.attempts + 8,
      });
      return json(200, { data: delivery });
    }
    return undefined;
  }

  function statusPageView(page: StatusPage): StatusPage {
    return {
      ...page,
      monitors: page.monitors
        .filter((m) => monitors.has(m.monitorId))
        .map((m) => {
          const mon = monitors.get(m.monitorId)!;
          return {
            ...m,
            monitorName: mon.name,
            currentStatus: mon.currentStatus,
            enabled: mon.enabled,
          };
        }),
    };
  }

  function seedStatusPage(
    overrides: Partial<StatusPage> & { title: string; slug: string },
  ): StatusPage {
    const at = tick();
    const page: StatusPage = {
      id: '00000000-0000-4000-b200-' + String(++sequence).padStart(12, '0'),
      description: null,
      published: false,
      publishedAt: null,
      monitors: [],
      createdAt: at,
      updatedAt: at,
      ...overrides,
    };
    fake.statusPages.push(page);
    return statusPageView(page);
  }

  /** The same safe, generated public view the server builds (no IDs, no internal text). */
  function publicView(page: StatusPage): PublicStatusPage {
    const view = statusPageView(page);
    const services = view.monitors.map((m, i) => ({
      key: 's' + (i + 1),
      name: m.displayName,
      status: m.enabled ? m.currentStatus : ('PAUSED' as const),
      lastCheckedAt: monitors.get(m.monitorId)!.lastCheckedAt,
      availabilityPercent: null,
      days: Array.from({ length: 30 }, (_, d) => ({
        date: new Date(Date.parse('2026-10-21T00:00:00.000Z') + d * 86_400_000)
          .toISOString()
          .slice(0, 10),
        availabilityPercent: null,
      })),
    }));
    const active = services.filter((x) => x.status !== 'PAUSED');
    const overallStatus = active.some((x) => x.status === 'DOWN')
      ? 'DOWN'
      : active.some((x) => x.status === 'DEGRADED')
        ? 'DEGRADED'
        : active.some((x) => x.status === 'HEALTHY')
          ? 'HEALTHY'
          : 'UNKNOWN';
    const incidents = fake.incidents
      .filter((inc) => view.monitors.some((m) => m.monitorId === inc.monitor.id))
      .map((inc, i) => {
        const name = view.monitors.find((m) => m.monitorId === inc.monitor.id)!.displayName;
        const status =
          inc.status === 'OPEN'
            ? 'INVESTIGATING'
            : inc.status === 'ACKNOWLEDGED'
              ? 'IDENTIFIED'
              : 'RESOLVED';
        return {
          key: 'i' + (i + 1),
          title: name + ' disruption',
          serviceName: name,
          status: status as 'INVESTIGATING' | 'IDENTIFIED' | 'RESOLVED',
          severity: inc.severity,
          startedAt: inc.startedAt,
          resolvedAt: inc.resolvedAt,
          summary:
            name +
            (status === 'RESOLVED'
              ? ' was unavailable or failing checks.'
              : ' is unavailable or failing checks. We are investigating.'),
        };
      });
    return {
      title: page.title,
      description: page.description,
      overallStatus,
      services,
      incidents,
      historyDays: 30,
      generatedAt: '2026-11-19T10:30:00.000Z',
    };
  }

  function handleStatusPages(method: string, url: URL, body: unknown): Response | undefined {
    const path = url.pathname;
    const publicMatch = /^\/api\/v1\/public\/status-pages\/([^/]+)$/.exec(path);
    if (publicMatch && method === 'GET') {
      const page = fake.statusPages.find(
        (p) => p.slug === decodeURIComponent(publicMatch[1]!) && p.published,
      );
      return page
        ? json(200, { data: publicView(page) })
        : error(404, 'STATUS_PAGE_NOT_FOUND', 'Status page not found');
    }
    if (path === '/api/v1/status-pages' && method === 'GET') {
      return json(200, {
        data: {
          items: [...fake.statusPages]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(({ monitors: m, ...p }) => ({ ...p, monitorCount: m.length })),
          quota: { used: fake.statusPages.length, limit: 10 },
        },
      });
    }
    if (path === '/api/v1/status-pages' && method === 'POST') {
      const parsed = CreateStatusPageSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      const slug =
        parsed.data.slug ??
        parsed.data.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
      if (fake.statusPages.some((p) => p.slug === slug)) {
        return error(
          409,
          'STATUS_PAGE_SLUG_TAKEN',
          'This address is already in use. Choose another one.',
          [{ path: 'slug', message: 'This address is already in use' }],
        );
      }
      return json(201, {
        data: seedStatusPage({
          title: parsed.data.title,
          description: parsed.data.description ?? null,
          slug,
        }),
      });
    }
    const m =
      /^\/api\/v1\/status-pages\/([^/]+)(\/publish|\/unpublish|\/preview|\/monitors(?:\/order|\/[^/]+)?)?$/.exec(
        path,
      );
    if (!m) return undefined;
    const page = fake.statusPages.find((p) => p.id === decodeURIComponent(m[1]!));
    if (!page) return error(404, 'STATUS_PAGE_NOT_FOUND', 'Status page not found');
    const action = m[2] ?? '';
    const touched = () => {
      page.updatedAt = tick();
      return json(200, { data: statusPageView(page) });
    };
    if (!action && method === 'GET') return json(200, { data: statusPageView(page) });
    if (!action && method === 'DELETE') {
      fake.statusPages = fake.statusPages.filter((p) => p.id !== page.id);
      return json(204);
    }
    if (!action && method === 'PATCH') {
      const parsed = UpdateStatusPageSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      if (
        parsed.data.slug &&
        fake.statusPages.some((p) => p.slug === parsed.data.slug && p.id !== page.id)
      ) {
        return error(
          409,
          'STATUS_PAGE_SLUG_TAKEN',
          'This address is already in use. Choose another one.',
          [{ path: 'slug', message: 'This address is already in use' }],
        );
      }
      Object.assign(page, parsed.data);
      return touched();
    }
    if (action === '/publish' || action === '/unpublish') {
      page.published = action === '/publish';
      if (page.published) page.publishedAt = tick();
      return touched();
    }
    if (action === '/preview') return json(200, { data: publicView(page) });
    if (action === '/monitors' && method === 'POST') {
      const parsed = AddStatusPageMonitorSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      const mon = monitors.get(parsed.data.monitorId);
      if (!mon) return error(404, 'MONITOR_NOT_FOUND', 'Monitor not found');
      if (page.monitors.some((x) => x.monitorId === mon.id)) {
        return error(409, 'STATUS_PAGE_MONITOR_EXISTS', 'This monitor is already on the page.');
      }
      page.monitors.push({
        monitorId: mon.id,
        monitorName: mon.name,
        displayName: parsed.data.displayName ?? mon.name,
        position: page.monitors.length,
        currentStatus: mon.currentStatus,
        enabled: mon.enabled,
      });
      page.updatedAt = tick();
      return json(201, { data: statusPageView(page) });
    }
    if (action === '/monitors/order' && method === 'PUT') {
      const parsed = ReorderStatusPageMonitorsSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      page.monitors = parsed.data.monitorIds.map((id, position) => ({
        ...page.monitors.find((x) => x.monitorId === id)!,
        position,
      }));
      return touched();
    }
    const monitorId = action.startsWith('/monitors/')
      ? decodeURIComponent(action.slice('/monitors/'.length))
      : '';
    const entry = page.monitors.find((x) => x.monitorId === monitorId);
    if (monitorId && !entry) return error(404, 'MONITOR_NOT_FOUND', 'Monitor not found');
    if (entry && method === 'PATCH') {
      const parsed = UpdateStatusPageMonitorSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      entry.displayName = parsed.data.displayName;
      return touched();
    }
    if (entry && method === 'DELETE') {
      page.monitors = page.monitors
        .filter((x) => x !== entry)
        .map((x, position) => ({ ...x, position }));
      return touched();
    }
    return undefined;
  }

  async function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const path = url.pathname;
    if (path.startsWith('/api/v1/status-pages') || path.startsWith('/api/v1/public/')) {
      const response = handleStatusPages(method, url, body);
      if (response) return response;
    }
    if (path.startsWith('/api/v1/notifications') || path.endsWith('/notifications')) {
      const response = handleNotifications(method, url, body);
      if (response) return response;
    }
    if (path.startsWith('/api/v1/analytics') || path.endsWith('/metrics')) {
      const response = handleAnalytics(method, url);
      if (response) return response;
    }
    if (path.startsWith('/api/v1/incidents')) {
      const response = handleIncidents(method, url, body);
      if (response) return response;
    }
    if (path === '/api/v1/me' && method === 'GET') {
      return json(200, {
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'harness@example.com',
          profile: {
            id: '11111111-1111-4111-8111-111111111111',
            displayName: null,
            createdAt: '2026-11-01T09:00:00.000Z',
            updatedAt: '2026-11-01T09:00:00.000Z',
          },
        },
      });
    }

    if (path === '/api/v1/monitors' && method === 'GET') {
      const query = MonitorListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return validationError(query.error);
      const { search, state, status, limit, cursor } = query.data;
      const all = [...monitors.values()]
        .filter(
          (m) =>
            (!search || m.name.toLowerCase().includes(search.toLowerCase())) &&
            (state === 'all' || m.enabled === (state === 'enabled')) &&
            (!status || m.currentStatus === status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const start = cursor ? all.findIndex((m) => m.id === atob(cursor)) + 1 : 0;
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      return json(200, {
        data: {
          items: page.map(summary),
          nextCursor: start + limit < all.length && last ? btoa(last.id) : null,
          total: all.length,
          quota: { used: monitors.size, limit: fake.quotaLimit },
        },
      });
    }

    if (path === '/api/v1/monitors' && method === 'POST') {
      const parsed = CreateMonitorSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      if (monitors.size >= fake.quotaLimit) {
        return error(409, 'MONITOR_LIMIT_REACHED', 'Monitor limit reached');
      }
      const { headers, ...input } = parsed.data;
      const updatedAt = tick();
      const created = seed({
        ...input,
        bodyContentType: resolveBodyContentType(input.requestBody, input.bodyContentType),
        headers: headers.map((h) => ({ ...h, updatedAt })),
      });
      return json(201, { data: created });
    }

    const match =
      /^\/api\/v1\/monitors\/([^/]+)(\/headers|\/pause|\/resume|\/checks|\/check)?$/.exec(path);
    const monitor = match ? monitors.get(decodeURIComponent(match[1]!)) : undefined;
    if (match && !monitor) return error(404, 'MONITOR_NOT_FOUND', 'Monitor not found');
    if (!match || !monitor) return error(404, 'NOT_FOUND', `No route for ${method} ${path}`);
    const action = match[2];

    if (!action && method === 'GET') return json(200, { data: view(monitor) });

    if (!action && method === 'DELETE') {
      monitors.delete(monitor.id);
      fake.incidents = fake.incidents.filter((i) => i.monitor.id !== monitor.id);
      return json(204);
    }

    if (action === '/check' && method === 'POST') {
      if (!monitor.enabled) {
        return error(409, 'MONITOR_PAUSED', 'This monitor is paused. Resume it to run checks.');
      }
      if (monitor.manualCheckQueuedAt) {
        return error(
          409,
          'CHECK_ALREADY_QUEUED',
          'A manual check for this monitor is already queued.',
        );
      }
      monitor.manualCheckQueuedAt = tick();
      return json(202, {
        data: { monitorId: monitor.id, status: 'QUEUED', queuedAt: monitor.manualCheckQueuedAt },
      });
    }

    if (action === '/checks' && method === 'GET') {
      const query = MonitorCheckListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return validationError(query.error);
      const { source, limit, cursor } = query.data;
      const all = (checks.get(monitor.id) ?? []).filter((c) => !source || c.source === source);
      const start = cursor ? all.findIndex((c) => c.id === atob(cursor)) + 1 : 0;
      const page = all.slice(start, start + limit);
      const last = page.at(-1);
      return json(200, {
        data: {
          items: page,
          nextCursor: start + limit < all.length && last ? btoa(last.id) : null,
        },
      });
    }

    if ((action === '/pause' || action === '/resume') && method === 'POST') {
      monitor.enabled = action === '/resume';
      if (!monitor.enabled) monitor.manualCheckQueuedAt = null;
      if (monitor.enabled) monitor.nextCheckAt = tick();
      monitor.updatedAt = tick();
      return json(200, { data: view(monitor) });
    }

    if (action === '/headers' && method === 'PATCH') {
      const parsed = MonitorHeaderUpdateSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      const removing = new Set(parsed.data.remove.map((n) => n.toLowerCase()));
      monitor.headers = monitor.headers.filter((h) => !removing.has(h.name.toLowerCase()));
      const updatedAt = tick();
      for (const h of parsed.data.upsert) {
        monitor.headers = monitor.headers.filter(
          (x) => x.name.toLowerCase() !== h.name.toLowerCase(),
        );
        monitor.headers.push({ ...h, updatedAt });
      }
      monitor.updatedAt = updatedAt;
      return json(200, { data: view(monitor) });
    }

    if (!action && method === 'PATCH') {
      const parsed = UpdateMonitorSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      const patch = parsed.data;
      const originChanged =
        patch.url !== undefined && monitorOrigin(patch.url) !== monitorOrigin(monitor.url);
      const clear = originChanged && (monitor.headers.length > 0 || monitor.requestBody !== null);
      if (clear && patch.confirmOriginChange !== true) {
        return error(
          409,
          'MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED',
          'Changing the destination will remove the saved request headers and request body.',
        );
      }
      const requestBody =
        'requestBody' in patch ? (patch.requestBody ?? null) : clear ? null : monitor.requestBody;
      const contentType =
        'bodyContentType' in patch
          ? (patch.bodyContentType ?? null)
          : requestBody && !clear
            ? monitor.bodyContentType
            : null;
      const next = {
        method: patch.method ?? monitor.method,
        timeoutMs: patch.timeoutMs ?? monitor.timeoutMs,
        latencyThresholdMs: patch.latencyThresholdMs ?? monitor.latencyThresholdMs,
        allowMutatingRequests: patch.allowMutatingRequests ?? monitor.allowMutatingRequests,
      };
      const issues = findMonitorConfigIssues({
        ...next,
        requestBody,
        bodyContentType: contentType,
      });
      if (issues.length) return error(400, 'VALIDATION_ERROR', 'Request validation failed', issues);
      const { confirmOriginChange: _c, requestBody: _rb, bodyContentType: _ct, ...rest } = patch;
      Object.assign(monitor, rest, {
        requestBody,
        bodyContentType: resolveBodyContentType(requestBody, contentType),
        updatedAt: tick(),
      });
      if (clear) monitor.headers = [];
      return json(200, {
        data: view(monitor),
        meta: { originChanged, savedConfigurationCleared: clear },
      });
    }

    return error(404, 'NOT_FOUND', `No route for ${method} ${path}`);
  }

  function recordCheck(
    monitorId: string,
    check: Partial<MonitorCheck> & Pick<MonitorCheck, 'outcome'>,
    health: { currentStatus?: MonitorStatus } = {},
  ): MonitorCheck {
    const monitor = monitors.get(monitorId);
    if (!monitor) throw new Error(`No monitor ${monitorId}`);
    const passing = check.outcome !== 'FAILURE';
    const row: MonitorCheck = {
      id: `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`,
      checkedAt: tick(),
      source: 'SCHEDULED',
      statusCode: passing ? 200 : null,
      latencyMs: passing ? 120 : null,
      failureReason: passing ? null : 'CONNECTION_ERROR',
      errorMessage: passing
        ? null
        : 'GET https://api.example.com/health: the connection failed or was closed',
      ...check,
    };
    checks.set(monitorId, [row, ...(checks.get(monitorId) ?? [])]);
    monitor.lastCheckedAt = row.checkedAt;
    if (health.currentStatus && health.currentStatus !== monitor.currentStatus) {
      monitor.currentStatus = health.currentStatus;
      monitor.statusChangedAt = row.checkedAt;
    }
    return row;
  }

  const fake: FakeMonitorApi = {
    statusPages: [],
    seedStatusPage,
    notificationSettings: new Map(),
    emailAddress: '11111111@example.com',
    emailProviderConfigured: true,
    deliveries: [],
    seedDelivery,
    analytics: { overview: {}, metrics: new Map() },
    incidents: [],
    incidentEvents: new Map(),
    seedIncident,
    monitors,
    checks,
    recordCheck,
    completeManualCheck(monitorId, check, health) {
      const monitor = monitors.get(monitorId);
      if (!monitor?.manualCheckQueuedAt) throw new Error('No manual check queued');
      const row = recordCheck(monitorId, { ...check, source: 'MANUAL' }, health);
      monitor.manualCheckQueuedAt = null;
      monitor.lastManualCheckAt = row.checkedAt;
      return row;
    },
    requests,
    seed,
    latencyMs: 0,
    quotaLimit: options.quotaLimit ?? 25,
    failNext(method, path, response) {
      overrides.push({ method, path, response });
    },
    fetch: async (input, init) => {
      const url = new URL(String(input), 'http://rain.test');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({ method, path: `${url.pathname}${url.search}`, body });
      if (fake.latencyMs) await new Promise((r) => setTimeout(r, fake.latencyMs));
      const index = overrides.findIndex((o) => o.method === method && o.path.test(url.pathname));
      if (index >= 0) {
        const { response } = overrides.splice(index, 1)[0]!;
        if (response === 'network-error') throw new TypeError('Failed to fetch');
        return response.body === undefined
          ? json(response.status)
          : json(response.status, response.body);
      }
      return handle(method, url, body);
    },
  };
  return fake;
}

export const statusesForSeed: MonitorStatus[] = ['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'];
