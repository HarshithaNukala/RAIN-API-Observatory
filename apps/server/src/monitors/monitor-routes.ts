import {
  CreateMonitorSchema,
  MonitorHeaderUpdateSchema,
  MonitorCheckListQuerySchema,
  MonitorListQuerySchema,
  UpdateMonitorSchema,
  type DataEnvelope,
  type ManualCheckQueued,
  type MonitorCheckList,
  type Monitor,
  type MonitorList,
  type MonitorUpdateResponse,
} from '@rain/shared';
import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { currentUser } from '../auth/require-auth.js';
import { AppError } from '../errors.js';
import { monitorNotFound, type MonitorService } from './monitor-service.js';

const monitorIdSchema = z.uuid();

/** A malformed ID can't name an existing monitor, so it gets the same 404 as an unknown one. */
function monitorId(req: Request): string {
  const parsed = monitorIdSchema.safeParse(req.params.monitorId);
  if (!parsed.success) throw monitorNotFound();
  return parsed.data.toLowerCase();
}

/**
 * HTTP layer only: parse and validate input, call the service with the authenticated user's ID,
 * shape the response. Mounted behind `requireAuth`.
 */
export interface ManualCheckRateLimits {
  /** Check Now requests per user per minute, across all their monitors. */
  perUserPerMinute: number;
  /** Check Now requests per client IP per minute. */
  perIpPerMinute: number;
}

export const DEFAULT_MANUAL_CHECK_RATE_LIMITS: ManualCheckRateLimits = {
  perUserPerMinute: 20,
  perIpPerMinute: 30,
};

function manualCheckLimiters(limits: ManualCheckRateLimits): RequestHandler[] {
  const rejected = (scope: string) => () =>
    new AppError(
      429,
      'RATE_LIMITED',
      `Too many manual checks ${scope}. Wait a minute and try again.`,
    );
  const common = { windowMs: 60_000, standardHeaders: 'draft-8', legacyHeaders: false } as const;
  return [
    rateLimit({
      ...common,
      limit: limits.perIpPerMinute,
      handler: (_req, _res, next) => next(rejected('from this network')()),
    }),
    rateLimit({
      ...common,
      limit: limits.perUserPerMinute,
      // Runs behind requireAuth, so the user is known.
      keyGenerator: (req) => `user:${currentUser(req).id}`,
      handler: (_req, _res, next) => next(rejected('for your account')()),
    }),
  ];
}

export function monitorRouter(
  service: MonitorService,
  options: { manualCheckRateLimits?: ManualCheckRateLimits } = {},
): Router {
  const router = Router();
  const one = (data: Monitor): DataEnvelope<Monitor> => ({ data });

  router.post('/monitors', async (req, res) => {
    const input = CreateMonitorSchema.parse(req.body);
    const monitor = await service.create(currentUser(req).id, input);
    res.status(201).location(`/api/v1/monitors/${monitor.id}`).json(one(monitor));
  });

  router.get('/monitors', async (req, res) => {
    const query = MonitorListQuerySchema.parse(req.query);
    const body: DataEnvelope<MonitorList> = {
      data: await service.list(currentUser(req).id, query),
    };
    res.json(body);
  });

  router.get('/monitors/:monitorId', async (req, res) => {
    res.json(one(await service.get(currentUser(req).id, monitorId(req))));
  });

  router.patch('/monitors/:monitorId', async (req, res) => {
    const id = monitorId(req);
    const patch = UpdateMonitorSchema.parse(req.body);
    const { monitor, meta } = await service.update(currentUser(req).id, id, patch);
    const body: MonitorUpdateResponse = { data: monitor, meta };
    res.json(body);
  });

  router.patch('/monitors/:monitorId/headers', async (req, res) => {
    const id = monitorId(req);
    const update = MonitorHeaderUpdateSchema.parse(req.body);
    res.json(one(await service.updateHeaders(currentUser(req).id, id, update)));
  });

  router.post('/monitors/:monitorId/pause', async (req, res) => {
    res.json(one(await service.pause(currentUser(req).id, monitorId(req))));
  });

  router.post('/monitors/:monitorId/resume', async (req, res) => {
    res.json(one(await service.resume(currentUser(req).id, monitorId(req))));
  });

  // Queues a check in PostgreSQL for the worker; the API never sends the monitored request.
  router.post(
    '/monitors/:monitorId/check',
    ...manualCheckLimiters(options.manualCheckRateLimits ?? DEFAULT_MANUAL_CHECK_RATE_LIMITS),
    async (req, res) => {
      const body: DataEnvelope<ManualCheckQueued> = {
        data: await service.requestCheck(currentUser(req).id, monitorId(req)),
      };
      res.status(202).json(body);
    },
  );

  router.get('/monitors/:monitorId/checks', async (req, res) => {
    const id = monitorId(req);
    const query = MonitorCheckListQuerySchema.parse(req.query);
    const body: DataEnvelope<MonitorCheckList> = {
      data: await service.listChecks(currentUser(req).id, id, query),
    };
    res.json(body);
  });

  router.delete('/monitors/:monitorId', async (req, res) => {
    await service.remove(currentUser(req).id, monitorId(req));
    res.status(204).end();
  });

  return router;
}
