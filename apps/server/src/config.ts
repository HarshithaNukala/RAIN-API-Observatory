import { z } from 'zod';
import { EncryptionKeyError, parseEncryptionKey } from './crypto/secret-box.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type NodeEnv = 'development' | 'test' | 'production';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: 'must be a postgres:// or postgresql:// connection URL',
});

const commonEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: postgresUrl,
});

const serverEnv = commonEnv.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SUPABASE_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }),
  SUPABASE_JWT_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters (the legacy Supabase JWT secret)')
    .optional(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default('authenticated'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  ENCRYPTION_KEY: z.string({ error: 'is required (base64-encoded 32-byte key)' }),
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(32_767).default(1),
  ENCRYPTION_PREVIOUS_KEYS: z.string().default(''),
  MAX_MONITORS_PER_USER: z.coerce.number().int().min(1).max(1000).default(25),
});

export interface WorkerConfig {
  env: NodeEnv;
  logLevel: LogLevel;
  databaseUrl: string;
}

export interface AuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  legacyHs256Secret: string | undefined;
}

export interface EncryptionConfig {
  currentVersion: number;
  /** Current key plus any retired keys still needed to read existing rows. */
  keys: Map<number, Buffer>;
}

export interface ServerConfig extends WorkerConfig {
  port: number;
  auth: AuthConfig;
  corsOrigins: string[];
  trustProxy: number;
  encryption: EncryptionConfig;
  maxMonitorsPerUser: number;
}

type Env = Record<string, string | undefined>;

/** `KEY=` in a .env file means "not set", not "set to the empty string". */
function withoutEmptyValues(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
}

/** Formats issues by key only, so secret values never end up in logs. */
function parseOrThrow<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(withoutEmptyValues(env));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

function parseOrigins(raw: string): string[] {
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const problems: string[] = [];
  const normalised = origins.map((origin) => {
    const url = URL.parse(origin);
    if (!url || !/^https?:$/.test(url.protocol) || url.origin !== origin.replace(/\/$/, '')) {
      problems.push(`CORS_ORIGINS: "${origin}" is not an origin like https://app.example.com`);
    }
    return url?.origin ?? origin;
  });
  if (problems.length) throw new ConfigError(problems);
  return normalised;
}

/**
 * ENCRYPTION_KEY is the key for ENCRYPTION_KEY_VERSION. ENCRYPTION_PREVIOUS_KEYS holds retired
 * keys as `version:base64` pairs, comma-separated. Problems name the variable, never the value.
 */
function parseEncryption(current: string, version: number, previous: string): EncryptionConfig {
  const problems: string[] = [];
  const keys = new Map<number, Buffer>();
  const add = (label: string, keyVersion: number, encoded: string) => {
    try {
      if (keys.has(keyVersion)) throw new EncryptionKeyError(`duplicate key version ${keyVersion}`);
      keys.set(keyVersion, parseEncryptionKey(encoded));
    } catch (err) {
      if (!(err instanceof EncryptionKeyError)) throw err;
      problems.push(`${label}: ${err.message}`);
    }
  };
  add('ENCRYPTION_KEY', version, current);
  for (const entry of previous
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const match = /^(\d{1,5}):(.+)$/.exec(entry);
    if (!match) {
      problems.push('ENCRYPTION_PREVIOUS_KEYS: entries must look like <version>:<base64 key>');
      continue;
    }
    add(`ENCRYPTION_PREVIOUS_KEYS (version ${match[1]})`, Number(match[1]), match[2] ?? '');
  }
  if (problems.length) throw new ConfigError(problems);
  return { currentVersion: version, keys };
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  const parsed = parseOrThrow(commonEnv, env);
  return { env: parsed.NODE_ENV, logLevel: parsed.LOG_LEVEL, databaseUrl: parsed.DATABASE_URL };
}

export function loadServerConfig(env: Env): ServerConfig {
  const parsed = parseOrThrow(serverEnv, env);
  const supabaseUrl = parsed.SUPABASE_URL.replace(/\/+$/, '');
  if (parsed.NODE_ENV === 'production' && !supabaseUrl.startsWith('https://')) {
    throw new ConfigError(['SUPABASE_URL: must use https in production']);
  }
  return {
    env: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    auth: {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: parsed.SUPABASE_JWT_AUDIENCE,
      jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      legacyHs256Secret: parsed.SUPABASE_JWT_SECRET,
    },
    corsOrigins: parseOrigins(parsed.CORS_ORIGINS),
    trustProxy: parsed.TRUST_PROXY,
    encryption: parseEncryption(
      parsed.ENCRYPTION_KEY,
      parsed.ENCRYPTION_KEY_VERSION,
      parsed.ENCRYPTION_PREVIOUS_KEYS,
    ),
    maxMonitorsPerUser: parsed.MAX_MONITORS_PER_USER,
  };
}
