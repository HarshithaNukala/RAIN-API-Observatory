import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadServerConfig, loadWorkerConfig } from './config.js';

const SECRET_DB_URL = 'postgresql://app:sup3r-s3cret@localhost:5432/rain_dev';

const KEY = randomBytes(32).toString('base64');

const validEnv = {
  DATABASE_URL: SECRET_DB_URL,
  SUPABASE_URL: 'https://abc123.supabase.co/',
  ENCRYPTION_KEY: KEY,
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

  it('loads optional Gemini and MongoDB settings and never echoes secrets on error', () => {
    expect(loadServerConfig(validEnv).ai).toEqual({ gemini: null, mongodb: null });

    const configured = loadServerConfig({
      ...validEnv,
      GEMINI_API_KEY: 'AIzaSyValidTestKey123',
      GEMINI_MODEL: 'gemini-2.5-flash',
      MONGODB_URI: 'mongodb://localhost:27017/rain_ai',
      MONGODB_DB_NAME: 'rain_ai_dev',
    });
    expect(configured.ai).toEqual({
      gemini: { apiKey: 'AIzaSyValidTestKey123', model: 'gemini-2.5-flash' },
      mongodb: { uri: 'mongodb://localhost:27017/rain_ai', dbName: 'rain_ai_dev' },
    });

    const bad = (() => {
      try {
        loadServerConfig({
          ...validEnv,
          GEMINI_API_KEY: 'tiny-key',
          MONGODB_URI: 'http://not-mongo',
        });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected failure');
    })();
    expect(bad.message).toContain('GEMINI_API_KEY');
    expect(bad.message).toContain('MONGODB_URI');
    expect(bad.message).not.toContain('tiny-key');
    expect(bad.message).not.toContain('http://not-mongo');
  });
});

describe('loadServerConfig encryption and limits', () => {
  it('requires ENCRYPTION_KEY and never generates one', () => {
    const { ENCRYPTION_KEY: _omitted, ...withoutKey } = validEnv;
    expect(problemsOf(() => loadServerConfig(withoutKey)).join(' ')).toMatch(/ENCRYPTION_KEY/);
  });

  it('loads the current key as version 1 by default', () => {
    const { encryption } = loadServerConfig(validEnv);
    expect(encryption.currentVersion).toBe(1);
    expect(encryption.keys.get(1)).toEqual(Buffer.from(KEY, 'base64'));
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['not base64', 'this is definitely not a key!!'],
    ['all zeros', Buffer.alloc(32).toString('base64')],
  ])('rejects a key that is %s without echoing it', (_label, bad) => {
    const err = (() => {
      try {
        loadServerConfig({ ...validEnv, ENCRYPTION_KEY: bad });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected failure');
    })();
    expect(err.message).toMatch(/ENCRYPTION_KEY/);
    expect(err.message).not.toContain(bad);
  });

  it('loads retired keys for rotation', () => {
    const old = randomBytes(32).toString('base64');
    const { encryption } = loadServerConfig({
      ...validEnv,
      ENCRYPTION_KEY_VERSION: '2',
      ENCRYPTION_PREVIOUS_KEYS: `1:${old}`,
    });
    expect(encryption.currentVersion).toBe(2);
    expect([...encryption.keys.keys()].sort()).toEqual([1, 2]);
    expect(encryption.keys.get(1)).toEqual(Buffer.from(old, 'base64'));
  });

  it('rejects a retired key that reuses the current version', () => {
    const problems = problemsOf(() =>
      loadServerConfig({ ...validEnv, ENCRYPTION_PREVIOUS_KEYS: `1:${KEY}` }),
    );
    expect(problems[0]).toMatch(/duplicate key version 1/);
  });

  it('rejects malformed retired-key entries', () => {
    const problems = problemsOf(() =>
      loadServerConfig({ ...validEnv, ENCRYPTION_PREVIOUS_KEYS: 'just-a-key' }),
    );
    expect(problems[0]).toMatch(/ENCRYPTION_PREVIOUS_KEYS/);
  });

  it('defaults the monitor quota to 25 and allows overriding it', () => {
    expect(loadServerConfig(validEnv).maxMonitorsPerUser).toBe(25);
    expect(loadServerConfig({ ...validEnv, MAX_MONITORS_PER_USER: '5' }).maxMonitorsPerUser).toBe(
      5,
    );
    expect(
      problemsOf(() => loadServerConfig({ ...validEnv, MAX_MONITORS_PER_USER: '0' }))[0],
    ).toMatch(/MAX_MONITORS_PER_USER/);
  });
});

describe('loadWorkerConfig', () => {
  const workerEnv = { DATABASE_URL: SECRET_DB_URL, ENCRYPTION_KEY: KEY };

  it('needs the database URL and the encryption key, and applies worker defaults', () => {
    const config = loadWorkerConfig({ ...workerEnv, LOG_LEVEL: 'debug' });
    expect(config).toMatchObject({
      env: 'development',
      logLevel: 'debug',
      databaseUrl: SECRET_DB_URL,
      worker: { concurrency: 25, pollIntervalMs: 1000, leaseSeconds: 90, shutdownGraceMs: 35_000 },
    });
    expect(config.encryption.keys.get(1)).toHaveLength(32);
  });

  it('requires the encryption key, without echoing secrets', () => {
    const problems = problemsOf(() => loadWorkerConfig({ DATABASE_URL: SECRET_DB_URL }));
    expect(problems.join()).toMatch(/ENCRYPTION_KEY/);
    expect(problems.join()).not.toContain('sup3r-s3cret');
  });

  it('rejects an unknown log level', () => {
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, LOG_LEVEL: 'loud' }))[0]).toMatch(
      /LOG_LEVEL/,
    );
  });

  it('rejects a lease that would not outlast the longest request', () => {
    expect(
      problemsOf(() => loadWorkerConfig({ ...workerEnv, WORKER_LEASE_SECONDS: '30' }))[0],
    ).toMatch(/WORKER_LEASE_SECONDS: must be at least 45/);
  });

  it('rejects out-of-range concurrency and poll interval', () => {
    const problems = problemsOf(() =>
      loadWorkerConfig({ ...workerEnv, WORKER_CONCURRENCY: '0', WORKER_POLL_INTERVAL_MS: '5' }),
    );
    expect(problems.join()).toMatch(/WORKER_CONCURRENCY/);
    expect(problems.join()).toMatch(/WORKER_POLL_INTERVAL_MS/);
  });
});
