import { z } from 'zod';

export interface WebEnv {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export type WebEnvResult = { ok: true; env: WebEnv } | { ok: false; problems: string[] };

const schema = z.object({
  VITE_SUPABASE_URL: z.url({ protocol: /^https?$/, error: 'must be your Supabase project URL' }),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(20, 'must be the publishable (anon) key'),
});

function jwtRole(key: string): unknown {
  const payload = key.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { role?: unknown }).role;
  } catch {
    return undefined;
  }
}

/** Anything in VITE_* ships to every visitor, so a privileged key here is a credential leak. */
function isPrivilegedKey(key: string): boolean {
  return key.startsWith('sb_secret_') || jwtRole(key) === 'service_role';
}

export function parseWebEnv(raw: Record<string, unknown>): WebEnvResult {
  const parsed = schema.safeParse({
    VITE_SUPABASE_URL: raw.VITE_SUPABASE_URL || undefined,
    VITE_SUPABASE_PUBLISHABLE_KEY: raw.VITE_SUPABASE_PUBLISHABLE_KEY || undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  if (isPrivilegedKey(parsed.data.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    return {
      ok: false,
      problems: [
        'VITE_SUPABASE_PUBLISHABLE_KEY: this is a secret/service-role key. Use the publishable ' +
          '(anon) key instead, and rotate the secret key if this build was ever deployed.',
      ],
    };
  }
  return {
    ok: true,
    env: {
      supabaseUrl: parsed.data.VITE_SUPABASE_URL.replace(/\/+$/, ''),
      supabasePublishableKey: parsed.data.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
  };
}
