/**
 * UI HARNESS — development only. Served by the Vite dev server at /harness.html and never part
 * of the production build (vite build only bundles index.html). It renders the real route table
 * and components against the in-memory fake monitor API with a placeholder session, so the
 * signed-in screens can be inspected without a Supabase project. Nothing here is real data,
 * real authentication or a real backend, and the banner says so on every screen.
 */
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Toaster } from 'sonner';
import '../index.css';
import { AuthContext, type AuthContextValue } from '@/auth/auth-context';
import { createApiClient } from '@/lib/api-client';
import { createQueryClient } from '@/lib/query-client';
import { routes } from '@/router';
import { createFakeMonitorApi } from './fake-monitor-api';

const fake = createFakeMonitorApi();
fake.latencyMs = 250;
fake.seed({
  name: 'Payments API',
  description: 'Card authorisation endpoint',
  url: 'https://payments.example.com/v1/health',
  method: 'POST',
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
    <div className="bg-warning px-4 py-1 text-center text-xs font-medium text-black">
      UI harness · in-memory fake API · placeholder session · not connected to RAIN or Supabase
    </div>
    <QueryClientProvider client={createQueryClient()}>
      <AuthContext.Provider value={auth}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
