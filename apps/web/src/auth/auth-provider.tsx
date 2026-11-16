import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createApiClient } from '@/lib/api-client';
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context';

export function AuthProvider({
  supabase,
  children,
}: {
  supabase: SupabaseClient;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  // undefined = still restoring the persisted session (and exchanging any ?code= in the URL).
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'SIGNED_OUT') queryClient.clear();
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabase, queryClient]);

  const api = useMemo(
    () =>
      createApiClient({
        getAccessToken: async () =>
          (await supabase.auth.getSession()).data.session?.access_token ?? null,
        refreshAccessToken: async () =>
          (await supabase.auth.refreshSession()).data.session?.access_token ?? null,
      }),
    [supabase],
  );

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    // Clear the local session even if revoking it server-side failed (e.g. offline).
    if (error) await supabase.auth.signOut({ scope: 'local' });
  }, [supabase]);

  const value = useMemo<AuthContextValue>(() => {
    const auth: AuthStatus =
      session === undefined
        ? { status: 'loading' }
        : session
          ? { status: 'signed-in', session }
          : { status: 'signed-out' };
    return { auth, supabase, api, signOut };
  }, [session, supabase, api, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
