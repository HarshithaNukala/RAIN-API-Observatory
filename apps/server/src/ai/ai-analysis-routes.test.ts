import { randomUUID } from 'node:crypto';
import {
  AI_ANALYSIS_PROMPT_VERSION,
  AiAnalysisDocumentSchema,
  AiAnalysisListResponseSchema,
  ApiErrorSchema,
  dataEnvelope,
  type AiAnalysisDocument,
} from '@rain/shared';
import { pino } from 'pino';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { stubAiAnalysisService } from '../test-support/ai-analysis-service-stub.js';
import { stubAnalyticsService } from '../test-support/analytics-service-stub.js';
import { client } from '../test-support/http.js';
import { stubIncidentService } from '../test-support/incident-service-stub.js';
import { stubMonitorService } from '../test-support/monitor-service-stub.js';
import { stubNotificationService } from '../test-support/notification-service-stub.js';
import { stubStatusPageService } from '../test-support/status-page-service-stub.js';
import { TEST_AUDIENCE, TEST_ISSUER, createTestSigner } from '../test-support/tokens.js';
import type { AiAnalysisService } from './ai-analysis-service.js';

const userId = randomUUID();
const incidentId = randomUUID();
const analysisId = '507f1f77bcf86cd799439011';
let auth: string;
let signer: Awaited<ReturnType<typeof createTestSigner>>;

const sampleDoc: AiAnalysisDocument = {
  id: analysisId,
  incidentId,
  monitorId: randomUUID(),
  promptVersion: AI_ANALYSIS_PROMPT_VERSION,
  model: 'gemini-2.5-flash',
  focusQuestion: null,
  analysis: {
    incidentSummary: 'Monitor experienced consecutive 503 responses.',
    potentialCauses: ['Upstream overload.'],
    supportingEvidence: ['Two checks failed with HTTP 503.'],
    suggestedInvestigationSteps: ['Inspect upstream status page.'],
    recommendedActions: ['Verify recovery.'],
    confidenceLevel: 'MEDIUM',
    limitations: ['No target server logs available.'],
  },
  operatorNotes: null,
  helpful: null,
  contextSnapshot: {
    monitorName: 'Payments',
    incidentStatus: 'OPEN',
    incidentSeverity: 'HIGH',
    checksAnalyzed: 2,
    failedChecksInWindow: 2,
    avgLatencyMs: 45,
  },
  createdAt: '2026-11-26T10:00:00.000Z',
  updatedAt: '2026-11-26T10:00:00.000Z',
};

beforeAll(async () => {
  signer = await createTestSigner();
  auth = `Bearer ${await signer.sign({ sub: userId })}`;
});

function appWith(service: Partial<AiAnalysisService>, perUserPerMinute = 10) {
  return client(
    createApp({
      logger: pino({ level: 'silent' }),
      corsOrigins: [],
      trustProxy: 0,
      verifyAccessToken: createTokenVerifier({
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks: signer.jwks,
      }),
      profiles: { ensure: () => Promise.reject(new Error('unused')) },
      monitors: stubMonitorService(),
      incidents: stubIncidentService(),
      aiAnalyses: stubAiAnalysisService(service),
      aiRateLimits: { perUserPerMinute, perIpPerMinute: 100 },
      analytics: stubAnalyticsService(),
      notifications: stubNotificationService(),
      statusPages: stubStatusPageService(),
      readiness: async () => ({ database: 'ok', auth: 'ok' }),
    }),
  );
}

describe('AI analysis routes', () => {
  it('requires authentication on all endpoints', async () => {
    const app = appWith({});
    await app.get(`/api/v1/incidents/${incidentId}/ai-analyses`).expect(401);
    await app.post(`/api/v1/incidents/${incidentId}/ai-analyses`).send({}).expect(401);
    await app
      .patch(`/api/v1/incidents/${incidentId}/ai-analyses/${analysisId}`)
      .send({ helpful: true })
      .expect(401);
    await app.delete(`/api/v1/incidents/${incidentId}/ai-analyses/${analysisId}`).expect(401);
  });

  it('GET /ai-analyses passes owner and limit', async () => {
    const list = vi.fn<AiAnalysisService['list']>(async () => ({
      items: [sampleDoc],
      capability: {
        available: true,
        geminiConfigured: true,
        mongodbConfigured: true,
        reason: null,
      },
    }));
    const res = await appWith({ list })
      .get(`/api/v1/incidents/${incidentId}/ai-analyses?limit=5`)
      .set('Authorization', auth)
      .expect(200);
    expect(dataEnvelope(AiAnalysisListResponseSchema).parse(res.body).data.items).toHaveLength(1);
    expect(list).toHaveBeenCalledWith(userId, incidentId, 5);
  });

  it('POST /ai-analyses validates body, invokes service, and enforces closure rate limiters', async () => {
    const generate = vi.fn<AiAnalysisService['generate']>(async () => sampleDoc);
    const app = appWith({ generate }, 2);

    const res = await app
      .post(`/api/v1/incidents/${incidentId}/ai-analyses`)
      .set('Authorization', auth)
      .send({ focusQuestion: 'Why did latency spike?' })
      .expect(201);
    expect(dataEnvelope(AiAnalysisDocumentSchema).parse(res.body).data.id).toBe(analysisId);
    expect(generate).toHaveBeenCalledWith(userId, incidentId, {
      focusQuestion: 'Why did latency spike?',
    });

    await app
      .post(`/api/v1/incidents/${incidentId}/ai-analyses`)
      .set('Authorization', auth)
      .send({})
      .expect(201);

    const limited = await app
      .post(`/api/v1/incidents/${incidentId}/ai-analyses`)
      .set('Authorization', auth)
      .send({})
      .expect(429);
    expect(ApiErrorSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
  });

  it('PATCH and DELETE validate IDs and payloads', async () => {
    const update = vi.fn<AiAnalysisService['update']>(async () => ({
      ...sampleDoc,
      operatorNotes: 'Verified',
      helpful: true,
    }));
    const remove = vi.fn<AiAnalysisService['remove']>(async () => {});
    const app = appWith({ update, remove });

    await app
      .patch(`/api/v1/incidents/${incidentId}/ai-analyses/${analysisId}`)
      .set('Authorization', auth)
      .send({ operatorNotes: 'Verified', helpful: true })
      .expect(200);
    expect(update).toHaveBeenCalledWith(userId, incidentId, analysisId, {
      operatorNotes: 'Verified',
      helpful: true,
    });

    await app
      .patch(`/api/v1/incidents/${incidentId}/ai-analyses/not-an-object-id`)
      .set('Authorization', auth)
      .send({ helpful: true })
      .expect(404);

    await app
      .patch(`/api/v1/incidents/${incidentId}/ai-analyses/${analysisId}`)
      .set('Authorization', auth)
      .send({})
      .expect(400);

    await app
      .delete(`/api/v1/incidents/${incidentId}/ai-analyses/${analysisId}`)
      .set('Authorization', auth)
      .expect(204);
    expect(remove).toHaveBeenCalledWith(userId, incidentId, analysisId);
  });
});
