import { describe, expect, it } from 'vitest';
import { parseWebEnv } from './env';

const fakeJwt = (payload: object) =>
  ['eyJhbGciOiJIUzI1NiJ9', btoa(JSON.stringify(payload)).replace(/=+$/, ''), 'sig'].join('.');

describe('parseWebEnv', () => {
  it('accepts a project URL and publishable key', () => {
    const result = parseWebEnv({
      VITE_SUPABASE_URL: 'https://abc.supabase.co/',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdef',
    });
    expect(result).toEqual({
      ok: true,
      env: {
        supabaseUrl: 'https://abc.supabase.co',
        supabasePublishableKey: 'sb_publishable_0123456789abcdef',
      },
    });
  });

  it('accepts a legacy anon JWT key', () => {
    const result = parseWebEnv({
      VITE_SUPABASE_URL: 'https://abc.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: fakeJwt({ role: 'anon', iss: 'supabase' }),
    });
    expect(result.ok).toBe(true);
  });

  it('reports missing variables (empty strings count as missing)', () => {
    const result = parseWebEnv({ VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(2);
  });

  it.each([
    ['a new-style secret key', 'sb_secret_0123456789abcdefghij'],
    ['a legacy service_role JWT', fakeJwt({ role: 'service_role', iss: 'supabase' })],
  ])('refuses %s in the browser bundle', (_label, key) => {
    const result = parseWebEnv({
      VITE_SUPABASE_URL: 'https://abc.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/secret\/service-role/);
  });
});
