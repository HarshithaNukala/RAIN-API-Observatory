import {
  NotificationListQuerySchema,
  UpdateNotificationSettingsSchema,
  type DataEnvelope,
  type NotificationDeliveryDetail,
  type NotificationList,
  type NotificationSettings,
  type NotificationSettingsUpdateResponse,
} from '@rain/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/require-auth.js';
import { monitorNotFound } from '../monitors/monitor-service.js';
import { notificationNotFound, type NotificationService } from './notification-service.js';

const uuid = z.uuid();

function param(req: Request, name: 'monitorId' | 'notificationId'): string {
  const parsed = uuid.safeParse(req.params[name]);
  if (!parsed.success) throw name === 'monitorId' ? monitorNotFound() : notificationNotFound();
  return parsed.data.toLowerCase();
}

/** HTTP layer only. Mounted behind `requireAuth`; every call is scoped to the caller. */
export function notificationRouter(service: NotificationService): Router {
  const router = Router();

  router.get('/monitors/:monitorId/notifications', async (req, res) => {
    const user = currentUser(req);
    const body: DataEnvelope<NotificationSettings> = {
      data: await service.getSettings(user.id, user.email, param(req, 'monitorId')),
    };
    res.json(body);
  });

  router.put('/monitors/:monitorId/notifications', async (req, res) => {
    const user = currentUser(req);
    const id = param(req, 'monitorId');
    const patch = UpdateNotificationSettingsSchema.parse(req.body);
    const body: DataEnvelope<NotificationSettingsUpdateResponse> = {
      data: await service.updateSettings(user.id, user.email, id, patch),
    };
    res.json(body);
  });

  router.get('/notifications', async (req, res) => {
    const query = NotificationListQuerySchema.parse(req.query);
    const body: DataEnvelope<NotificationList> = {
      data: await service.list(currentUser(req).id, query),
    };
    res.json(body);
  });

  router.get('/notifications/:notificationId', async (req, res) => {
    const body: DataEnvelope<NotificationDeliveryDetail> = {
      data: await service.get(currentUser(req).id, param(req, 'notificationId')),
    };
    res.json(body);
  });

  router.post('/notifications/:notificationId/retry', async (req, res) => {
    const body: DataEnvelope<NotificationDeliveryDetail> = {
      data: await service.retry(currentUser(req).id, param(req, 'notificationId')),
    };
    res.json(body);
  });

  return router;
}
