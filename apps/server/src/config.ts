import { z } from 'zod';
import { EncryptionKeyError, parseEncryptionKey } from './crypto/secret-box.js';
import {
  DEFAULT_WORKER_SETTINGS,
  MIN_LEASE_SECONDS,
  type WorkerSettings,
} from './monitoring/worker-engine.js';
import {
  MIN_DISPATCH_LEASE_SECONDS,
  type DispatcherSettings,
} from './notifications/notification-dispatcher.js';

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

const encryptionEnv = {
  ENCRYPTION_KEY: z.string({ error: 'is required (base64-encoded 32-byte key)' }),
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(32_767).default(1),
  ENCRYPTION_PREVIOUS_KEYS: z.string().default(''),
};

/** Email is optional: without both values, emails fail visibly ("not configured"). */
const emailEnv = {
  RESEND_API_KEY: z.string().min(10, 'looks too short for a Resend API key').optional(),
  NOTIFICATION_EMAIL_FROM: z
    .string()
    .min(3)
    .max(320)
    .regex(/@/, 'must be a sender such as "RAIN <alerts@your-domain.com>"')
    .optional(),
};

function emailConfig(parsed: {
  RESEND_API_KEY?: string | undefined;
  NOTIFICATION_EMAIL_FROM?: string | undefined;
}): EmailConfig {
  return parsed.RESEND_API_KEY && parsed.NOTIFICATION_EMAIL_FROM
    ? { resend: { apiKey: parsed.RESEND_API_KEY, from: parsed.NOTIFICATION_EMAIL_FROM } }
    : { resend: null };
}

const workerEnv = commonEnv.extend({
  ...encryptionEnv,
  WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(DEFAULT_WORKER_SETTINGS.concurrency),
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(DEFAULT_WORKER_SETTINGS.pollIntervalMs),
  WORKER_LEASE_SECONDS: z.coerce
    .number()
    .int()
    .min(
      MIN_LEASE_SECONDS,
      `must be at least ${MIN_LEASE_SECONDS} (longest timeout plus a safety margin)`,
    )
    .max(3600)
    .default(DEFAULT_WORKER_SETTINGS.leaseSeconds),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(35_000),
  WORKER_DB_MAX_CONNECTIONS: z.coerce.number().int().min(2).max(100).default(10),
  ...emailEnv,
  APP_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'must be the web app URL, e.g. https://rain.example.com' })
    .default('http://localhost:5173'),
  NOTIFY_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  NOTIFY_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2000),
  NOTIFY_LEASE_SECONDS: z.coerce
    .number()
    .int()
    .min(MIN_DISPATCH_LEASE_SECONDS, `must be at least ${MIN_DISPATCH_LEASE_SECONDS}`)
    .max(3600)
    .default(60),
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
  ...encryptionEnv,
  ...emailEnv,
  MAX_MONITORS_PER_USER: z.coerce.number().int().min(1).max(1000).default(25),
});

export interface BaseConfig {
  env: NodeEnv;
  logLevel: LogLevel;
  databaseUrl: string;
}

export interface EmailConfig {
  /** Present only when both the API key and the sender address are set. */
  resend: { apiKey: string; from: string } | null;
}

export interface WorkerConfig extends BaseConfig {
  encryption: EncryptionConfig;
  worker: WorkerSettings & { shutdownGraceMs: number; dbMaxConnections: number };
  email: EmailConfig;
  appBaseUrl: string;
  dispatcher: DispatcherSettings;
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

export interface ServerConfig extends BaseConfig {
  port: number;
  auth: AuthConfig;
  corsOrigins: string[];
  trustProxy: number;
  encryption: EncryptionConfig;
  maxMonitorsPerUser: number;
  /** Whether the worker can send email (shown on the settings page; the key stays server-side). */
  emailConfigured: boolean;
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
  const parsed = parseOrThrow(workerEnv, env);
  const worker = {
    concurrency: parsed.WORKER_CONCURRENCY,
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: parsed.WORKER_LEASE_SECONDS,
    maxBackoffMs: Math.max(DEFAULT_WORKER_SETTINGS.maxBackoffMs, parsed.WORKER_POLL_INTERVAL_MS),
    shutdownGraceMs: parsed.WORKER_SHUTDOWN_GRACE_MS,
    // One connection per running check plus one for claiming, within the configured cap.
    dbMaxConnections: parsed.WORKER_DB_MAX_CONNECTIONS,
  };
  return {
    env: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    encryption: parseEncryption(
      parsed.ENCRYPTION_KEY,
      parsed.ENCRYPTION_KEY_VERSION,
      parsed.ENCRYPTION_PREVIOUS_KEYS,
    ),
    worker,
    email: emailConfig(parsed),
    appBaseUrl: parsed.APP_BASE_URL.replace(/\/+$/, ''),
    dispatcher: {
      concurrency: parsed.NOTIFY_CONCURRENCY,
      pollIntervalMs: parsed.NOTIFY_POLL_INTERVAL_MS,
      leaseSeconds: parsed.NOTIFY_LEASE_SECONDS,
      maxBackoffMs: Math.max(30_000, parsed.NOTIFY_POLL_INTERVAL_MS),
    },
  };
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
    emailConfigured: emailConfig(parsed).resend !== null,
  };
}
