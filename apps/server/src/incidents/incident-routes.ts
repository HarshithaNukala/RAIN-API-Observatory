import {
  IncidentCountsQuerySchema,
  IncidentEventListQuerySchema,
  IncidentListQuerySchema,
  UpdateIncidentSchema,
  type DataEnvelope,
  type Incident,
  type IncidentCounts,
  type IncidentEventList,
  type IncidentList,
} from '@rain/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/require-auth.js';
import { incidentNotFound, type IncidentService } from './incident-service.js';

const incidentIdSchema = z.uuid();

/** A malformed ID can't name an existing incident: same 404 as an unknown one. */
function incidentId(req: Request): string {
  const parsed = incidentIdSchema.safeParse(req.params.incidentId);
  if (!parsed.success) throw incidentNotFound();
  return parsed.data.toLowerCase();
}

/** HTTP layer only. Mounted behind `requireAuth`; every call passes the authenticated user. */
export function incidentRouter(service: IncidentService): Router {
  const router = Router();
  const one = (data: Incident): DataEnvelope<Incident> => ({ data });

  router.get('/incidents', async (req, res) => {
    const query = IncidentListQuerySchema.parse(req.query);
    const body: DataEnvelope<IncidentList> = {
      data: await service.list(currentUser(req).id, query),
    };
    res.json(body);
  });

  // Registered before /incidents/:incidentId so "counts" is never read as an ID.
  router.get('/incidents/counts', async (req, res) => {
    const { monitorId } = IncidentCountsQuerySchema.parse(req.query);
    const body: DataEnvelope<IncidentCounts> = {
      data: await service.counts(currentUser(req).id, monitorId),
    };
    res.json(body);
  });

  router.get('/incidents/:incidentId', async (req, res) => {
    res.json(one(await service.get(currentUser(req).id, incidentId(req))));
  });

  router.get('/incidents/:incidentId/events', async (req, res) => {
    const id = incidentId(req);
    const query = IncidentEventListQuerySchema.parse(req.query);
    const body: DataEnvelope<IncidentEventList> = {
      data: await service.events(currentUser(req).id, id, query),
    };
    res.json(body);
  });

  router.post('/incidents/:incidentId/acknowledge', async (req, res) => {
    res.json(one(await service.acknowledge(currentUser(req).id, incidentId(req))));
  });

  router.patch('/incidents/:incidentId', async (req, res) => {
    const id = incidentId(req);
    const patch = UpdateIncidentSchema.parse(req.body);
    res.json(one(await service.update(currentUser(req).id, id, patch)));
  });

  return router;
}
