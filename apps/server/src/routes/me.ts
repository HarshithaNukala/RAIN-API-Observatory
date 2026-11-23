import type { DataEnvelope, Me } from '@rain/shared';
import { Router } from 'express';
import { currentUser } from '../auth/require-auth.js';
import type { ProfileStore } from '../db/profiles.js';

export function meRouter(profiles: ProfileStore): Router {
  const router = Router();

  router.get('/me', async (req, res) => {
    const user = currentUser(req);
    const profile = await profiles.ensure(user.id);
    const body: DataEnvelope<Me> = { data: { id: user.id, email: user.email, profile } };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  return router;
}
