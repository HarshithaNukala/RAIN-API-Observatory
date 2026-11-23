import {
  AnalyticsQuerySchema,
  type AnalyticsOverview,
  type DataEnvelope,
  type MonitorMetrics,
} from '@rain/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/require-auth.js';
import { monitorNotFound } from '../monitors/monitor-service.js';
import type { AnalyticsService } from './analytics-service.js';

const monitorIdSchema = z.uuid();

/** HTTP layer only. Mounted behind `requireAuth`; every query is scoped to the caller. */
export function analyticsRouter(service: AnalyticsService): Router {
  const router = Router();

  router.get('/analytics/overview', async (req, res) => {
    const { range } = AnalyticsQuerySchema.parse(req.query);
    const body: DataEnvelope<AnalyticsOverview> = {
      data: await service.overview(currentUser(req).id, range),
    };
    res.json(body);
  });

  router.get('/monitors/:monitorId/metrics', async (req, res) => {
    const id = monitorIdSchema.safeParse(req.params.monitorId);
    if (!id.success) throw monitorNotFound();
    const { range } = AnalyticsQuerySchema.parse(req.query);
    const body: DataEnvelope<MonitorMetrics> = {
      data: await service.monitorMetrics(currentUser(req).id, id.data.toLowerCase(), range),
    };
    res.json(body);
  });

  return router;
}
