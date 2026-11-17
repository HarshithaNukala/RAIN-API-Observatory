import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Toaster } from 'sonner';
import { vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/auth/auth-context';
import { createApiClient } from '@/lib/api-client';
import { routes } from '@/router';
import { createFakeMonitorApi, type FakeMonitorApi } from './fake-monitor-api';

/**
 * Renders the real route table, signed in with a test session, against the fake monitor API.
 * TEST ONLY: the session is not a real Supabase session and never reaches a server.
 */
export function renderApp(path: string, fake: FakeMonitorApi = createFakeMonitorApi()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  const signOut = vi.fn(async () => {});
  const auth: AuthContextValue = {
    auth: {
      status: 'signed-in',
      session: { user: { email: 'tester@example.com' } } as Session,
    },
    supabase: {} as SupabaseClient,
    api: createApiClient({
      getAccessToken: async () => 'test-token',
      refreshAccessToken: async () => null,
      fetch: fake.fetch,
    }),
    signOut,
  };
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...view, user, router, fake, signOut, queryClient };
}
