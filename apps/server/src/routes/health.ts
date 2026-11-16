import type { Liveness, Readiness } from '@rain/shared';
import { Router } from 'express';

export type ReadinessProbe = () => Promise<Readiness['checks']>;

export function healthRouter(probe: ReadinessProbe): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    const body: Liveness = { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
    res.json(body);
  });

  router.get('/readyz', async (_req, res) => {
    const checks = await probe();
    const ready = Object.values(checks).every((c) => c === 'ok');
    const body: Readiness = { status: ready ? 'ready' : 'not_ready', checks };
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json(body);
  });

  return router;
}
