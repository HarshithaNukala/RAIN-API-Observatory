import {
  CreateMonitorSchema,
  MonitorHeaderUpdateSchema,
  MonitorListQuerySchema,
  UpdateMonitorSchema,
  type DataEnvelope,
  type Monitor,
  type MonitorList,
  type MonitorUpdateResponse,
} from '@rain/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/require-auth.js';
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
export function monitorRouter(service: MonitorService): Router {
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

  router.delete('/monitors/:monitorId', async (req, res) => {
    await service.remove(currentUser(req).id, monitorId(req));
    res.status(204).end();
  });

  return router;
}
