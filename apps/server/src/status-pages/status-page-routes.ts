import {
  AddStatusPageMonitorSchema,
  CreateStatusPageSchema,
  ReorderStatusPageMonitorsSchema,
  StatusPageSlugSchema,
  UpdateStatusPageMonitorSchema,
  UpdateStatusPageSchema,
  type DataEnvelope,
  type PublicStatusPage,
  type StatusPage,
  type StatusPageList,
} from '@rain/shared';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { currentUser } from '../auth/require-auth.js';
import { AppError } from '../errors.js';
import { monitorNotFound } from '../monitors/monitor-service.js';
import { statusPageNotFound, type StatusPageService } from './status-page-service.js';

const uuid = z.uuid();

function pageId(req: Request): string {
  const parsed = uuid.safeParse(req.params.statusPageId);
  if (!parsed.success) throw statusPageNotFound();
  return parsed.data.toLowerCase();
}
function monitorId(req: Request): string {
  const parsed = uuid.safeParse(req.params.monitorId);
  if (!parsed.success) throw monitorNotFound();
  return parsed.data.toLowerCase();
}

/** Owner management API. Mounted behind `requireAuth`; every call is scoped to the caller. */
export function statusPageRouter(service: StatusPageService): Router {
  const router = Router();
  const one = (data: StatusPage): DataEnvelope<StatusPage> => ({ data });
  const base = '/status-pages/:statusPageId';

  router.post('/status-pages', async (req, res) => {
    const input = CreateStatusPageSchema.parse(req.body);
    const page = await service.create(currentUser(req).id, input);
    res.status(201).location(`/api/v1/status-pages/${page.id}`).json(one(page));
  });

  router.get('/status-pages', async (req, res) => {
    const body: DataEnvelope<StatusPageList> = { data: await service.list(currentUser(req).id) };
    res.json(body);
  });

  router.get(base, async (req, res) => {
    res.json(one(await service.get(currentUser(req).id, pageId(req))));
  });

  router.patch(base, async (req, res) => {
    const id = pageId(req);
    const patch = UpdateStatusPageSchema.parse(req.body);
    res.json(one(await service.update(currentUser(req).id, id, patch)));
  });

  router.delete(base, async (req, res) => {
    await service.remove(currentUser(req).id, pageId(req));
    res.status(204).end();
  });

  router.post(`${base}/publish`, async (req, res) => {
    res.json(one(await service.setPublished(currentUser(req).id, pageId(req), true)));
  });

  router.post(`${base}/unpublish`, async (req, res) => {
    res.json(one(await service.setPublished(currentUser(req).id, pageId(req), false)));
  });

  router.get(`${base}/preview`, async (req, res) => {
    const body: DataEnvelope<PublicStatusPage> = {
      data: await service.preview(currentUser(req).id, pageId(req)),
    };
    res.json(body);
  });

  router.post(`${base}/monitors`, async (req, res) => {
    const id = pageId(req);
    const input = AddStatusPageMonitorSchema.parse(req.body);
    res.status(201).json(one(await service.addMonitor(currentUser(req).id, id, input)));
  });

  // Registered before /monitors/:monitorId so "order" is never read as an ID.
  router.put(`${base}/monitors/order`, async (req, res) => {
    const id = pageId(req);
    const { monitorIds } = ReorderStatusPageMonitorsSchema.parse(req.body);
    res.json(one(await service.reorderMonitors(currentUser(req).id, id, monitorIds)));
  });

  router.patch(`${base}/monitors/:monitorId`, async (req, res) => {
    const id = pageId(req);
    const mId = monitorId(req);
    const { displayName } = UpdateStatusPageMonitorSchema.parse(req.body);
    res.json(one(await service.renameMonitor(currentUser(req).id, id, mId, displayName)));
  });

  router.delete(`${base}/monitors/:monitorId`, async (req, res) => {
    const id = pageId(req);
    res.json(one(await service.removeMonitor(currentUser(req).id, id, monitorId(req))));
  });

  return router;
}

/**
 * The public, unauthenticated API: published pages only, by slug. Its own per-IP rate limit; no
 * caching anywhere (`no-store`), so unpublishing or changing a page takes effect immediately.
 */
export function publicStatusPageRouter(
  service: StatusPageService,
  options: { perIpPerMinute?: number } = {},
): Router {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: options.perIpPerMinute ?? 60,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) =>
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down')),
    }),
  );
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  });

  router.get('/status-pages/:slug', async (req, res) => {
    // Any malformed slug is simply "not found": nothing reveals what exists.
    const slug = StatusPageSlugSchema.safeParse(req.params.slug);
    if (!slug.success) throw statusPageNotFound();
    const body: DataEnvelope<PublicStatusPage> = { data: await service.publicView(slug.data) };
    res.json(body);
  });

  return router;
}
