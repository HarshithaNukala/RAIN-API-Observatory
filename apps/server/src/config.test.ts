import { describe, expect, it } from 'vitest';
import { ConfigError, loadServerConfig, loadWorkerConfig } from './config.js';

const SECRET_DB_URL = 'postgresql://app:sup3r-s3cret@localhost:5432/rain_dev';

const validEnv = {
  DATABASE_URL: SECRET_DB_URL,
  SUPABASE_URL: 'https://abc123.supabase.co/',
};

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadServerConfig', () => {
  it('derives Supabase issuer and JWKS URL and applies defaults', () => {
    const config = loadServerConfig(validEnv);
    expect(config).toMatchObject({
      env: 'development',
      port: 3000,
      logLevel: 'info',
      trustProxy: 0,
      corsOrigins: [],
      auth: {
        issuer: 'https://abc123.supabase.co/auth/v1',
        audience: 'authenticated',
        jwksUrl: 'https://abc123.supabase.co/auth/v1/.well-known/jwks.json',
        legacyHs256Secret: undefined,
      },
    });
  });

  it('reports every missing required variable', () => {
    const problems = problemsOf(() => loadServerConfig({}));
    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/SUPABASE_URL/);
  });

  it('treats empty values from a .env file as missing', () => {
    const problems = problemsOf(() => loadServerConfig({ ...validEnv, SUPABASE_URL: '' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^SUPABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    const problems = problemsOf(() =>
      loadServerConfig({ ...validEnv, DATABASE_URL: 'mysql://u:p@localhost/db' }),
    );
    expect(problems[0]).toMatch(/^DATABASE_URL/);
  });

  it('never echoes secret values in error messages', () => {
    const err = (() => {
      try {
        loadServerConfig({ ...validEnv, PORT: 'not-a-port', SUPABASE_JWT_SECRET: 'short-secret' });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected failure');
    })();
    expect(err.message).toMatch(/SUPABASE_JWT_SECRET/);
    expect(err.message).not.toContain('short-secret');
    expect(err.message).not.toContain('sup3r-s3cret');
  });

  it('parses and normalises CORS origins', () => {
    const config = loadServerConfig({
      ...validEnv,
      CORS_ORIGINS: 'http://localhost:5173, https://rain.example.com/',
    });
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://rain.example.com']);
  });

  it('rejects CORS entries that are not bare origins', () => {
    const problems = problemsOf(() =>
      loadServerConfig({ ...validEnv, CORS_ORIGINS: 'https://rain.example.com/app' }),
    );
    expect(problems[0]).toMatch(/CORS_ORIGINS/);
  });

  it('accepts a legacy HS256 secret of sufficient length', () => {
    const secret = 'x'.repeat(40);
    expect(
      loadServerConfig({ ...validEnv, SUPABASE_JWT_SECRET: secret }).auth.legacyHs256Secret,
    ).toBe(secret);
  });

  it('requires https for Supabase in production', () => {
    const problems = problemsOf(() =>
      loadServerConfig({
        ...validEnv,
        NODE_ENV: 'production',
        SUPABASE_URL: 'http://localhost:54321',
      }),
    );
    expect(problems[0]).toMatch(/https/);
  });

  it('allows a local http Supabase URL in development', () => {
    expect(
      loadServerConfig({ ...validEnv, SUPABASE_URL: 'http://127.0.0.1:54321' }).auth.issuer,
    ).toBe('http://127.0.0.1:54321/auth/v1');
  });
});

describe('loadWorkerConfig', () => {
  it('needs only the database URL', () => {
    expect(loadWorkerConfig({ DATABASE_URL: SECRET_DB_URL, LOG_LEVEL: 'debug' })).toEqual({
      env: 'development',
      logLevel: 'debug',
      databaseUrl: SECRET_DB_URL,
    });
  });

  it('rejects an unknown log level', () => {
    expect(
      problemsOf(() => loadWorkerConfig({ DATABASE_URL: SECRET_DB_URL, LOG_LEVEL: 'loud' }))[0],
    ).toMatch(/LOG_LEVEL/);
  });
});
