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
import { monitorRouter, type ManualCheckRateLimits } from './monitors/monitor-routes.js';
import type { MonitorService } from './monitors/monitor-service.js';
import { analyticsRouter } from './analytics/analytics-routes.js';
import type { AnalyticsService } from './analytics/analytics-service.js';
import { publicStatusPageRouter, statusPageRouter } from './status-pages/status-page-routes.js';
import type { StatusPageService } from './status-pages/status-page-service.js';
import { notificationRouter } from './notifications/notification-routes.js';
import type { NotificationService } from './notifications/notification-service.js';
import { incidentRouter } from './incidents/incident-routes.js';
import type { IncidentService } from './incidents/incident-service.js';
import { healthRouter, type ReadinessProbe } from './routes/health.js';
import { meRouter } from './routes/me.js';

export interface AppDependencies {
  logger: Logger;
  corsOrigins: string[];
  trustProxy: number;
  verifyAccessToken: VerifyAccessToken;
  profiles: ProfileStore;
  monitors: MonitorService;
  incidents: IncidentService;
  analytics: AnalyticsService;
  notifications: NotificationService;
  statusPages: StatusPageService;
  /** Requests per minute per client IP on the public status-page API. */
  publicRateLimitPerMinute?: number;
  readiness: ReadinessProbe;
  /** Requests per minute per client IP on /api. */
  rateLimitPerMinute?: number;
  /** Extra limits on POST /monitors/:id/check. */
  manualCheckRateLimits?: ManualCheckRateLimits;
}

// Room for a 32 KB request body plus the maximum set of headers (32 KB), JSON-encoded.
export const BODY_LIMIT = '256kb';

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

  // Public status pages: no authentication, their own rate limit, never cached. Mounted before
  // the authenticated /api router so these paths never reach requireAuth.
  app.use(
    '/api/v1/public',
    publicStatusPageRouter(deps.statusPages, { perIpPerMinute: deps.publicRateLimitPerMinute }),
  );

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
  // Responses are per-user and may include request bodies; never let a cache keep them.
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use('/v1', meRouter(deps.profiles));
  api.use(
    '/v1',
    monitorRouter(deps.monitors, { manualCheckRateLimits: deps.manualCheckRateLimits }),
  );
  api.use('/v1', incidentRouter(deps.incidents));
  api.use('/v1', analyticsRouter(deps.analytics));
  api.use('/v1', notificationRouter(deps.notifications));
  api.use('/v1', statusPageRouter(deps.statusPages));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
