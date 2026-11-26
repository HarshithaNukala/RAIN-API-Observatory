import {
  AiAnalysisListQuerySchema,
  GenerateAiAnalysisSchema,
  UpdateAiAnalysisSchema,
  type AiAnalysisDocument,
  type AiAnalysisListResponse,
  type DataEnvelope,
} from '@rain/shared';
import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { currentUser } from '../auth/require-auth.js';
import { AppError } from '../errors.js';
import { incidentNotFound } from '../incidents/incident-service.js';
import { aiAnalysisNotFound, type AiAnalysisService } from './ai-analysis-service.js';

const incidentIdSchema = z.uuid();

function incidentId(req: Request): string {
  const parsed = incidentIdSchema.safeParse(req.params.incidentId);
  if (!parsed.success) throw incidentNotFound();
  return parsed.data.toLowerCase();
}

function analysisId(req: Request): string {
  const raw = req.params.analysisId;
  if (typeof raw !== 'string' || !/^[0-9a-f]{24}$/i.test(raw)) {
    throw aiAnalysisNotFound();
  }
  return raw.toLowerCase();
}

export interface AiAnalysisRateLimits {
  perUserPerMinute: number;
  perIpPerMinute: number;
}

export const DEFAULT_AI_ANALYSIS_RATE_LIMITS: AiAnalysisRateLimits = {
  perUserPerMinute: 10,
  perIpPerMinute: 20,
};

/**
 * Middleware factory using JavaScript closures: encapsulates `limits`, `common`, and the
 * `rejected` helper to build per-IP and per-user Express rate-limiting middleware.
 */
export function createAiRateLimiters(limits: AiAnalysisRateLimits): RequestHandler[] {
  const rejected = (scope: string) => () =>
    new AppError(
      429,
      'RATE_LIMITED',
      `Too many AI analysis requests ${scope}. Wait a minute and try again.`,
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
      keyGenerator: (req) => `user:${currentUser(req).id}`,
      handler: (_req, _res, next) => next(rejected('for your account')()),
    }),
  ];
}

/**
 * HTTP routes for AI incident analysis. Mounted behind `requireAuth` in `app.ts`.
 */
export function aiAnalysisRouter(
  service: AiAnalysisService,
  options: { rateLimits?: AiAnalysisRateLimits } = {},
): Router {
  const router = Router();
  const one = (data: AiAnalysisDocument): DataEnvelope<AiAnalysisDocument> => ({ data });

  router.get('/incidents/:incidentId/ai-analyses', async (req, res) => {
    const id = incidentId(req);
    const { limit } = AiAnalysisListQuerySchema.parse(req.query);
    const body: DataEnvelope<AiAnalysisListResponse> = {
      data: await service.list(currentUser(req).id, id, limit),
    };
    res.json(body);
  });

  router.post(
    '/incidents/:incidentId/ai-analyses',
    ...createAiRateLimiters(options.rateLimits ?? DEFAULT_AI_ANALYSIS_RATE_LIMITS),
    async (req, res) => {
      const id = incidentId(req);
      const input = GenerateAiAnalysisSchema.parse(req.body ?? {});
      const doc = await service.generate(currentUser(req).id, id, input);
      res.status(201).location(`/api/v1/incidents/${id}/ai-analyses/${doc.id}`).json(one(doc));
    },
  );

  router.patch('/incidents/:incidentId/ai-analyses/:analysisId', async (req, res) => {
    const id = incidentId(req);
    const aId = analysisId(req);
    const patch = UpdateAiAnalysisSchema.parse(req.body);
    res.json(one(await service.update(currentUser(req).id, id, aId, patch)));
  });

  router.delete('/incidents/:incidentId/ai-analyses/:analysisId', async (req, res) => {
    const id = incidentId(req);
    const aId = analysisId(req);
    await service.remove(currentUser(req).id, id, aId);
    res.status(204).end();
  });

  return router;
}
