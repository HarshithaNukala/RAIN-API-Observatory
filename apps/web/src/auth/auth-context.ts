import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createContext, useContext } from 'react';
import type { ApiClient } from '@/lib/api-client';

export type AuthStatus =
  { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };

export interface AuthContextValue {
  auth: AuthStatus;
  supabase: SupabaseClient;
  api: ApiClient;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
