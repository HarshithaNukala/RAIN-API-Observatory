import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './config.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.secret',
  '*.databaseUrl',
  '*.DATABASE_URL',
  '*.SUPABASE_JWT_SECRET',
  '*.apiKey',
  '*.RESEND_API_KEY',
  '*.ENCRYPTION_KEY',
  '*.signingSecret',
];

export interface LoggerOptions {
  service: 'api' | 'worker';
  level: LogLevel;
  pretty?: boolean;
  destination?: DestinationStream;
}

export function createLogger({ service, level, pretty, destination }: LoggerOptions): Logger {
  const options = {
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(pretty && !destination
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}
