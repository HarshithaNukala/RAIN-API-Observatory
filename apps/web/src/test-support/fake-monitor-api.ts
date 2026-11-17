/**
 * TEST AND UI-HARNESS ONLY. An in-memory stand-in for the RAIN monitor API, exposed as a `fetch`
 * function. It validates requests with the same shared schemas as the real server and follows the
 * same origin-change and header rules, so UI tests exercise realistic responses. It is not the
 * server: backend behaviour is verified by the server's own unit and integration tests.
 * Nothing in the production app imports this module.
 */
import {
  CreateMonitorSchema,
  MONITOR_LIMITS,
  MonitorHeaderUpdateSchema,
  MonitorListQuerySchema,
  UpdateMonitorSchema,
  findMonitorConfigIssues,
  monitorOrigin,
  resolveBodyContentType,
  type ApiFieldIssue,
  type Monitor,
  type MonitorStatus,
} from '@rain/shared';
import type { ZodError } from 'zod';

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
  /** Adds a monitor directly, as if created earlier. Returns it as the API would. */
  seed(overrides?: Partial<StoredMonitor> & { name: string }): Monitor;
  /** The next request matching method and path pattern gets this response instead. */
  failNext(method: string, path: RegExp, response: Override): void;
  /** Delays every response by this many milliseconds (to observe loading states). */
  latencyMs: number;
  quotaLimit: number;
}

export function createFakeMonitorApi(options: { quotaLimit?: number } = {}): FakeMonitorApi {
  const monitors = new Map<string, StoredMonitor>();
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
      headers: [],
      ...overrides,
    };
    monitors.set(id, monitor);
    return view(monitor);
  }

  async function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const path = url.pathname;
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

    const match = /^\/api\/v1\/monitors\/([^/]+)(\/headers|\/pause|\/resume)?$/.exec(path);
    const monitor = match ? monitors.get(decodeURIComponent(match[1]!)) : undefined;
    if (match && !monitor) return error(404, 'MONITOR_NOT_FOUND', 'Monitor not found');
    if (!match || !monitor) return error(404, 'NOT_FOUND', `No route for ${method} ${path}`);
    const action = match[2];

    if (!action && method === 'GET') return json(200, { data: view(monitor) });

    if (!action && method === 'DELETE') {
      monitors.delete(monitor.id);
      return json(204);
    }

    if ((action === '/pause' || action === '/resume') && method === 'POST') {
      monitor.enabled = action === '/resume';
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

  const fake: FakeMonitorApi = {
    monitors,
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
