import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WebEnv } from './env';

export function createSupabase(env: WebEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: {
      // PKCE: email-confirmation and recovery links return a one-time ?code= that the client
      // exchanges for a session, instead of putting tokens in the URL fragment.
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}
