import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { requireAuth } from './auth/require-auth.js';
import type { VerifyAccessToken } from './auth/verify-token.js';
import type { ProfileStore } from './db/profiles.js';
import { AppError } from './errors.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { genRequestId } from './http/request-id.js';
import { healthRouter, type ReadinessProbe } from './routes/health.js';
import { meRouter } from './routes/me.js';

export interface AppDependencies {
  logger: Logger;
  corsOrigins: string[];
  trustProxy: number;
  verifyAccessToken: VerifyAccessToken;
  profiles: ProfileStore;
  readiness: ReadinessProbe;
  /** Requests per minute per client IP on /api. */
  rateLimitPerMinute?: number;
}

export const BODY_LIMIT = '100kb';

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy);

  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: genRequestId,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(helmet());
  const allowed = new Set(deps.corsOrigins);
  app.use(
    cors({
      origin: (origin, callback) => callback(null, origin === undefined || allowed.has(origin)),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: BODY_LIMIT }));

  app.use(healthRouter(deps.readiness));

  const api = express.Router();
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: deps.rateLimitPerMinute ?? 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down'));
      },
    }),
  );
  api.use(requireAuth(deps.verifyAccessToken));
  api.use('/v1', meRouter(deps.profiles));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
