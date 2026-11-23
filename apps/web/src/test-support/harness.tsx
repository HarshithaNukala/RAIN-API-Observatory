/**
 * UI HARNESS — development only. Served by the Vite dev server at /harness.html and never part
 * of the production build (vite build only bundles index.html). It renders the real route table
 * and components against the in-memory fake monitor API with a placeholder session, so the
 * signed-in screens can be inspected without a Supabase project. Nothing here is real data,
 * real authentication or a real backend, and the banner says so on every screen.
 */
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { QueryClientProvider } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Toaster } from 'sonner';
import '../index.css';
import { AuthContext, type AuthContextValue } from '@/auth/auth-context';
import { createApiClient } from '@/lib/api-client';
import { createQueryClient } from '@/lib/query-client';
import { routes } from '@/router';
import { emptySeries, makeOverview } from './analytics-fixtures';
import { createFakeMonitorApi } from './fake-monitor-api';

const fake = createFakeMonitorApi();
fake.latencyMs = 250;
fake.seed({
  name: 'Payments API',
  description: 'Card authorisation endpoint',
  url: 'https://payments.example.com/v1/health',
  method: 'POST',
  allowMutatingRequests: true,
  requestBody: '{"probe":true}',
  bodyContentType: 'application/json',
  checkIntervalSeconds: 60,
  headers: [
    { name: 'Authorization', value: 'fixture', updatedAt: '2026-11-17T09:00:00.000Z' },
    { name: 'X-Tenant', value: 'fixture', updatedAt: '2026-11-17T09:00:00.000Z' },
  ],
});
fake.seed({ name: 'Search API', url: 'https://search.example.com/status' });
fake.seed({
  name: 'Auth service',
  url: 'https://auth.example.com/ready',
  checkIntervalSeconds: 600,
});
fake.seed({ name: 'Webhooks', url: 'https://hooks.example.org/ping', enabled: false });
fake.seed({ name: 'Inventory', url: 'https://inventory.example.net/healthz', method: 'HEAD' });

// Fixture analytics (deterministic, fake): enough shape to inspect the charts' layout.
fake.analytics.overview['24h'] = makeOverview('24h', {
  monitors: { total: 5, healthy: 2, degraded: 1, down: 1, unknown: 0, paused: 1 },
  checks: {
    recorded: 1210,
    eligible: 1200,
    successful: 1179,
    failed: 21,
    slow: 44,
    excluded: 10,
    availabilityPercent: 98.25,
    failurePercent: 1.75,
  },
  latency: {
    samples: 1190,
    avgMs: 214.6,
    minMs: 38,
    maxMs: 4870,
    p50Ms: 162,
    p95Ms: 690.5,
    p99Ms: 2140,
  },
  series: emptySeries('24h', new Date().toISOString()).map((b, i) =>
    i < 3
      ? b
      : {
          ...b,
          eligible: 50,
          successful: 50 - (i % 7 === 0 ? 6 : i % 5 === 0 ? 2 : 0),
          failed: i % 7 === 0 ? 6 : i % 5 === 0 ? 2 : 0,
          availabilityPercent: i % 7 === 0 ? 88 : i % 5 === 0 ? 96 : 100,
          avgLatencyMs: 160 + 60 * Math.sin(i / 3),
          p95LatencyMs: 520 + 220 * Math.sin(i / 3 + 1),
          incidentsOpened: i === 7 || i === 21 ? 1 : 0,
          incidentsResolved: i === 8 ? 1 : 0,
        },
  ),
  failureReasons: [
    { reason: 'TIMEOUT', count: 12, excludedFromAvailability: false },
    { reason: 'UNEXPECTED_STATUS', count: 7, excludedFromAvailability: false },
    { reason: 'CONNECTION_ERROR', count: 2, excludedFromAvailability: false },
    { reason: 'BLOCKED_DESTINATION', count: 10, excludedFromAvailability: true },
  ],
  incidents: { opened: 2, resolved: 1, currentlyOpen: 1, averageResolutionMs: 1_260_000 },
});

// Fixture status page (fake): open /harness.html?path=/status/acme to inspect the public layout.
{
  const all = [...fake.monitors.values()];
  all[0]!.currentStatus = 'DEGRADED';
  all[1]!.currentStatus = 'HEALTHY';
  all[2]!.currentStatus = 'HEALTHY';
  const resolved = fake.seedIncident(all[0]!.id, {
    status: 'RESOLVED',
    startedAt: '2026-11-18T08:00:00.000Z',
    resolvedAt: '2026-11-18T08:42:00.000Z',
  });
  const open = fake.seedIncident(all[0]!.id, { startedAt: '2026-11-19T09:10:00.000Z' });

  // Fixture notification deliveries (fake): one of each outcome for the delivery history.
  const monitorRef = { id: all[0]!.id, name: all[0]!.name };
  fake.seedDelivery({
    monitor: monitorRef,
    incident: { id: resolved.id, title: resolved.title },
    attemptHistory: [
      {
        attemptNumber: 1,
        startedAt: '2026-11-18T08:00:05.000Z',
        finishedAt: '2026-11-18T08:00:05.400Z',
        outcome: 'SUCCESS',
        httpStatus: 200,
        error: null,
      },
    ],
  });
  fake.seedDelivery({
    monitor: monitorRef,
    incident: { id: resolved.id, title: resolved.title },
    eventType: 'INCIDENT_RESOLVED',
    channel: 'WEBHOOK',
    destination: 'hooks.example.org',
    attempts: 2,
    attemptHistory: [
      {
        attemptNumber: 1,
        startedAt: '2026-11-18T08:42:03.000Z',
        finishedAt: '2026-11-18T08:42:03.300Z',
        outcome: 'TEMPORARY_FAILURE',
        httpStatus: 503,
        error: 'The receiver responded with HTTP 503',
      },
      {
        attemptNumber: 2,
        startedAt: '2026-11-18T08:42:33.000Z',
        finishedAt: '2026-11-18T08:42:33.200Z',
        outcome: 'SUCCESS',
        httpStatus: 202,
        error: null,
      },
    ],
  });
  fake.seedDelivery({
    monitor: monitorRef,
    incident: { id: open.id, title: open.title },
    channel: 'WEBHOOK',
    status: 'FAILED',
    destination: 'hooks.example.org',
    attempts: 8,
    deliveredAt: null,
    lastError: 'The receiver responded with HTTP 410',
    attemptHistory: [
      {
        attemptNumber: 8,
        startedAt: '2026-11-19T10:40:00.000Z',
        finishedAt: '2026-11-19T10:40:00.300Z',
        outcome: 'PERMANENT_FAILURE',
        httpStatus: 410,
        error: 'The receiver responded with HTTP 410',
      },
    ],
  });
  fake.seedStatusPage({
    title: 'Acme Corp status',
    description: 'Current status of the Acme public APIs. Subscribe to updates on our blog.',
    slug: 'acme',
    published: true,
    publishedAt: '2026-11-17T09:00:00.000Z',
    monitors: all.slice(0, 4).map((m, position) => ({
      monitorId: m.id,
      monitorName: m.name,
      displayName: ['Payments API', 'Search', 'Authentication', 'Webhooks delivery'][position]!,
      position,
      currentStatus: m.currentStatus,
      enabled: m.enabled,
    })),
  });
}

const auth: AuthContextValue = {
  auth: { status: 'signed-in', session: { user: { email: 'harness@example.com' } } as Session },
  supabase: {} as SupabaseClient,
  api: createApiClient({
    getAccessToken: async () => 'harness',
    refreshAccessToken: async () => null,
    fetch: fake.fetch,
  }),
  signOut: async () => {
    alert('Harness: sign-out is not connected to Supabase.');
  },
};

const initialPath = new URLSearchParams(window.location.search).get('path') ?? '/app/monitors';
const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
// Exposed for scripted browser checks of the current in-app route.
(window as unknown as { harnessRouter: typeof router }).harnessRouter = router;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div
      role="note"
      className="flex items-center justify-center gap-2 bg-primary px-4 py-1.5 text-center text-xs font-semibold text-primary-foreground"
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      UI harness · in-memory fake API · placeholder session · not connected to RAIN or Supabase
    </div>
    <QueryClientProvider client={createQueryClient()}>
      <AuthContext.Provider value={auth}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
      <Toaster theme="light" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
