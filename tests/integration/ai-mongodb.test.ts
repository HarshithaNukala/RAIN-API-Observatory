import { randomUUID } from 'node:crypto';
import { AI_ANALYSIS_PROMPT_VERSION } from '@rain/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectAiMongo,
  createAiAnalysisRepository,
  type AiAnalysisRepository,
} from '../../apps/server/src/ai/ai-analysis-repository.js';
import { getIncidentAiAnalysisModel } from '../../apps/server/src/ai/ai-analysis-model.js';

const testMongoUri = process.env.TEST_MONGODB_URI;

describe.runIf(Boolean(testMongoUri))('MongoDB AI analysis integration', () => {
  let repo: AiAnalysisRepository;
  let closeMongo: () => Promise<void>;
  let cleanCollection: () => Promise<void>;

  beforeAll(async () => {
    if (!testMongoUri) return;
    const parsed = new URL(testMongoUri);
    const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'rain_ai_test';
    if (!dbName.endsWith('_test')) {
      throw new Error(`TEST_MONGODB_URI database "${dbName}" must end with "_test"`);
    }
    const handle = await connectAiMongo(testMongoUri, dbName);
    repo = createAiAnalysisRepository(handle.connection);
    const model = getIncidentAiAnalysisModel(handle.connection);
    cleanCollection = async () => {
      await model.deleteMany({});
    };
    closeMongo = handle.close;
  });

  afterAll(async () => {
    await closeMongo?.();
  });

  beforeEach(async () => {
    await cleanCollection?.();
  });

  it('performs owner-scoped CRUD against real MongoDB', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const incidentId = randomUUID();
    const monitorId = randomUUID();

    const created = await repo.create({
      ownerId: alice,
      incidentId,
      monitorId,
      promptVersion: AI_ANALYSIS_PROMPT_VERSION,
      model: 'gemini-2.5-flash',
      focusQuestion: 'Why did it time out?',
      analysis: {
        incidentSummary: 'Monitor timed out twice consecutively.',
        potentialCauses: ['Upstream slow response or network latency.'],
        supportingEvidence: ['Two checks failed with TIMEOUT.'],
        suggestedInvestigationSteps: ['Verify upstream latency.'],
        recommendedActions: ['Increase alert watch.'],
        confidenceLevel: 'MEDIUM',
        limitations: ['No server logs available.'],
      },
      contextSnapshot: {
        monitorName: 'Payments',
        incidentStatus: 'OPEN',
        incidentSeverity: 'HIGH',
        checksAnalyzed: 2,
        failedChecksInWindow: 2,
        avgLatencyMs: null,
      },
    });

    expect(await repo.listByIncident(alice, incidentId, 10)).toHaveLength(1);
    expect(await repo.listByIncident(bob, incidentId, 10)).toHaveLength(0);

    const updated = await repo.update(alice, incidentId, created.id, {
      operatorNotes: 'Verified with provider',
      helpful: true,
    });
    expect(updated?.operatorNotes).toBe('Verified with provider');
    expect(await repo.update(bob, incidentId, created.id, { helpful: false })).toBeNull();

    expect(await repo.remove(bob, incidentId, created.id)).toBe(false);
    expect(await repo.remove(alice, incidentId, created.id)).toBe(true);
    expect(await repo.findById(alice, incidentId, created.id)).toBeNull();
  });
});
