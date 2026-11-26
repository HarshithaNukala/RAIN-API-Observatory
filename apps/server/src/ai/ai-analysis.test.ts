import { randomUUID } from 'node:crypto';
import { AI_ANALYSIS_PROMPT_VERSION, type AiStructuredAnalysis } from '@rain/shared';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { createInMemoryAiAnalysisRepository } from '../test-support/in-memory-ai-repository.js';
import { createInMemoryIncidentRepository } from '../test-support/in-memory-incident-repository.js';
import { createInMemoryMonitorRepository } from '../test-support/in-memory-monitor-repository.js';
import { IncidentAiAnalysisSchema, getIncidentAiAnalysisModel } from './ai-analysis-model.js';
import { createAiAnalysisService } from './ai-analysis-service.js';
import { createGeminiClient, GEMINI_ANALYSIS_RESPONSE_SCHEMA } from './gemini-client.js';
import { buildIncidentAnalysisPrompt, sanitizePromptText } from './prompt-builder.js';

const validStructured: AiStructuredAnalysis = {
  incidentSummary: 'Payments API failed consecutive checks with HTTP 503 responses.',
  potentialCauses: ['Upstream service overload or maintenance window returning HTTP 503.'],
  supportingEvidence: ['Trigger check recorded HTTP 503 (UNEXPECTED_STATUS) at 20 ms latency.'],
  suggestedInvestigationSteps: [
    'Check upstream status page and recent error logs on Payments API.',
  ],
  recommendedActions: ['Verify endpoint recovery before acknowledging or muting alerts.'],
  confidenceLevel: 'MEDIUM',
  limitations: ['RAIN executes external black-box HTTP probes without target server internals.'],
};

function seedIncidentContext() {
  const ownerId = randomUUID();
  const monitorId = randomUUID();
  const triggerCheckId = randomUUID();
  const incidentId = randomUUID();
  const startedAt = new Date('2026-11-26T10:00:00.000Z');
  const monitors = createInMemoryMonitorRepository();
  monitors.monitors.push({
    id: monitorId,
    ownerId,
    name: 'Payments',
    description: null,
    url: 'https://api.example.com/health?token=topsecret123',
    method: 'GET',
    expectedStatusCode: 200,
    timeoutMs: 5000,
    latencyThresholdMs: 500,
    checkIntervalSeconds: 60,
    requestBodyCiphertext: 'cipher',
    requestBodyIv: 'iv',
    requestBodyAuthTag: 'tag',
    requestBodyKeyVersion: 1,
    bodyContentType: null,
    allowMutatingRequests: false,
    enabled: true,
    currentStatus: 'DOWN',
    consecutiveFailures: 2,
    consecutiveSuccesses: 0,
    statusChangedAt: startedAt,
    lastCheckedAt: startedAt,
    nextCheckAt: startedAt,
    leaseUntil: null,
    leaseToken: null,
    manualCheckRequestedAt: null,
    lastManualCheckAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  monitors.checks.push({
    id: triggerCheckId,
    monitorId,
    checkedAt: startedAt,
    source: 'SCHEDULED',
    attemptId: randomUUID(),
    outcome: 'FAILURE',
    statusCode: 503,
    latencyMs: 22,
    failureReason: 'UNEXPECTED_STATUS',
    errorMessage:
      'GET https://api.example.com/health: expected 200, got 503 (Bearer super-secret-jwt)',
    createdAt: startedAt,
  });
  monitors.incidents.push({
    id: incidentId,
    monitorId,
    ownerId,
    title: 'Payments is down',
    description: 'Automated outage detection',
    severity: 'HIGH',
    status: 'OPEN',
    startedAt,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    triggerCheckId,
    resolvedByCheckId: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  return {
    ownerId,
    monitorId,
    incidentId,
    incidentRepository: createInMemoryIncidentRepository(monitors),
  };
}

describe('prompt engineering and secret sanitization', () => {
  it('strips URL query strings and credential patterns from the prompt payload', async () => {
    const { ownerId, incidentId, incidentRepository } = seedIncidentContext();
    const ctx = await incidentRepository.findAnalysisContext(ownerId, incidentId);
    expect(ctx).toBeDefined();

    const built = buildIncidentAnalysisPrompt(ctx!, 'Check apiKey=my-leak-key');
    expect(built.promptVersion).toBe(AI_ANALYSIS_PROMPT_VERSION);
    expect(built.systemInstruction).toContain('Distinguish observed evidence from hypotheses');
    expect(built.systemInstruction).toContain('Never invent unobserved infrastructure causes');
    expect(built.userPrompt).toContain('GET https://api.example.com/health');
    expect(built.userPrompt).not.toContain('topsecret123');
    expect(built.userPrompt).not.toContain('super-secret-jwt');
    expect(built.userPrompt).not.toContain('my-leak-key');
    expect(built.userPrompt).toContain('[REDACTED]');
    expect(sanitizePromptText('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });
});

describe('createGeminiClient', () => {
  it('sends versioned prompt, x-goog-api-key header, and responseSchema, and validates JSON output', async () => {
    const { ownerId, incidentId, incidentRepository } = seedIncidentContext();
    const ctx = (await incidentRepository.findAnalysisContext(ownerId, incidentId))!;
    const prompt = buildIncidentAnalysisPrompt(ctx);

    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: JSON.stringify(validStructured) }] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = createGeminiClient({
      apiKey: 'AIzaSyTestKey123456',
      model: 'gemini-2.5-flash',
      fetchFn: fetchMock,
    });

    const result = await client.analyzeIncident(prompt);
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.analysis).toEqual(validStructured);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(String(url)).not.toContain('AIzaSyTestKey123456');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('AIzaSyTestKey123456');
    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual(GEMINI_ANALYSIS_RESPONSE_SCHEMA);
  });

  it('rejects malformed JSON or incomplete structured responses without leaking keys', async () => {
    const { ownerId, incidentId, incidentRepository } = seedIncidentContext();
    const prompt = buildIncidentAnalysisPrompt(
      (await incidentRepository.findAnalysisContext(ownerId, incidentId))!,
    );

    const badPayloads = [
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'not valid json {' }] } }],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ incidentSummary: 'only summary' }) }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }), { status: 200 }),
      new Response('upstream error', { status: 503 }),
    ];

    for (const response of badPayloads) {
      const client = createGeminiClient({
        apiKey: 'AIzaSySecretKey999999',
        model: 'gemini-2.5-flash',
        fetchFn: async () => response,
      });
      await expect(client.analyzeIncident(prompt)).rejects.toMatchObject({
        status: 502,
        code: 'AI_PROVIDER_ERROR',
      });
    }
  });

  it('aborts and throws AI_PROVIDER_ERROR when Gemini times out', async () => {
    const { ownerId, incidentId, incidentRepository } = seedIncidentContext();
    const prompt = buildIncidentAnalysisPrompt(
      (await incidentRepository.findAnalysisContext(ownerId, incidentId))!,
    );

    const client = createGeminiClient({
      apiKey: 'AIzaSySecretKey999999',
      model: 'gemini-2.5-flash',
      timeoutMs: 25,
      fetchFn: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });

    await expect(client.analyzeIncident(prompt)).rejects.toMatchObject({
      status: 502,
      code: 'AI_PROVIDER_ERROR',
    });
  });
});

describe('Mongoose schema modelling', () => {
  it('validates a well-formed document, enforces indexes, and rejects unknown secret fields', async () => {
    const conn = mongoose.createConnection();
    const Model = getIncidentAiAnalysisModel(conn);

    const indexes = IncidentAiAnalysisSchema.indexes();
    expect(indexes.map(([keys]) => keys)).toEqual([
      { ownerId: 1, incidentId: 1, createdAt: -1 },
      { ownerId: 1, _id: 1 },
    ]);

    const validDoc = new Model({
      ownerId: randomUUID(),
      incidentId: randomUUID(),
      monitorId: randomUUID(),
      promptVersion: AI_ANALYSIS_PROMPT_VERSION,
      model: 'gemini-2.5-flash',
      focusQuestion: null,
      analysis: validStructured,
      contextSnapshot: {
        monitorName: 'Payments',
        incidentStatus: 'OPEN',
        incidentSeverity: 'HIGH',
        checksAnalyzed: 2,
        failedChecksInWindow: 2,
        avgLatencyMs: 22,
      },
    });
    await expect(validDoc.validate()).resolves.toBeUndefined();

    // Strict mode throws if credentials / raw headers are passed.
    expect(
      () =>
        new Model({
          ownerId: randomUUID(),
          incidentId: randomUUID(),
          monitorId: randomUUID(),
          promptVersion: AI_ANALYSIS_PROMPT_VERSION,
          model: 'gemini-2.5-flash',
          analysis: validStructured,
          contextSnapshot: {
            monitorName: 'Payments',
            incidentStatus: 'OPEN',
            incidentSeverity: 'HIGH',
            checksAnalyzed: 1,
            failedChecksInWindow: 1,
            avgLatencyMs: null,
          },
          rawHeaders: { authorization: 'Bearer leak' },
        }),
    ).toThrow();

    const badConfidence = new Model({
      ownerId: 'not-a-uuid',
      incidentId: randomUUID(),
      monitorId: randomUUID(),
      promptVersion: AI_ANALYSIS_PROMPT_VERSION,
      model: 'gemini-2.5-flash',
      analysis: { ...validStructured, confidenceLevel: 'CERTAIN' },
      contextSnapshot: {
        monitorName: 'Payments',
        incidentStatus: 'OPEN',
        incidentSeverity: 'HIGH',
        checksAnalyzed: 1,
        failedChecksInWindow: 1,
        avgLatencyMs: null,
      },
    });
    await expect(badConfidence.validate()).rejects.toThrow();
    await conn.close();
  });
});

describe('AiAnalysisService CRUD and graceful degradation', () => {
  it('supports create (generate), list, update, delete scoped to the owner', async () => {
    const { ownerId, incidentId, incidentRepository } = seedIncidentContext();
    const otherOwner = randomUUID();
    const aiRepository = createInMemoryAiAnalysisRepository();
    const service = createAiAnalysisService({
      incidentRepository,
      aiRepository,
      geminiClient: {
        model: 'gemini-2.5-flash',
        analyzeIncident: async () => ({ model: 'gemini-2.5-flash', analysis: validStructured }),
      },
    });

    const created = await service.generate(ownerId, incidentId, {
      focusQuestion: 'Why did it 503?',
    });
    expect(created.incidentId).toBe(incidentId);
    expect(created.promptVersion).toBe(AI_ANALYSIS_PROMPT_VERSION);

    const listed = await service.list(ownerId, incidentId, 10);
    expect(listed.items).toHaveLength(1);
    expect(listed.capability.available).toBe(true);

    // Other user receives 404 INCIDENT_NOT_FOUND on every operation.
    await expect(service.list(otherOwner, incidentId, 10)).rejects.toMatchObject({
      code: 'INCIDENT_NOT_FOUND',
    });
    await expect(
      service.update(otherOwner, incidentId, created.id, { helpful: true }),
    ).rejects.toMatchObject({ code: 'INCIDENT_NOT_FOUND' });

    const updated = await service.update(ownerId, incidentId, created.id, {
      operatorNotes: 'Confirmed upstream outage on status page',
      helpful: true,
    });
    expect(updated.operatorNotes).toBe('Confirmed upstream outage on status page');
    expect(updated.helpful).toBe(true);

    await service.remove(ownerId, incidentId, created.id);
    expect((await service.list(ownerId, incidentId, 10)).items).toHaveLength(0);
    await expect(service.remove(ownerId, incidentId, created.id)).rejects.toBeInstanceOf(AppError);
  });

  it('returns capability unavailable without crashing when Gemini or MongoDB is missing', async () => {
    const { ownerId, incidentId, incidentRepository } = seedIncidentContext();
    const service = createAiAnalysisService({
      incidentRepository,
      aiRepository: null,
      geminiClient: null,
    });

    const list = await service.list(ownerId, incidentId, 10);
    expect(list.items).toEqual([]);
    expect(list.capability).toMatchObject({
      available: false,
      geminiConfigured: false,
      mongodbConfigured: false,
    });

    await expect(service.generate(ownerId, incidentId, {})).rejects.toMatchObject({
      status: 503,
      code: 'AI_NOT_CONFIGURED',
    });
  });
});
