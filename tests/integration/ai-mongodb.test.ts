import { randomUUID } from 'node:crypto';
import { AI_ANALYSIS_PROMPT_VERSION } from '@rain/shared';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getIncidentAiAnalysisModel } from '../../apps/server/src/ai/ai-analysis-model.js';
import {
  connectAiMongo,
  createAiAnalysisRepository,
  type AiAnalysisRepository,
} from '../../apps/server/src/ai/ai-analysis-repository.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertSafeTestMongoUri(raw: string, allowedHosts: string[] = []): string {
  const parsed = URL.parse(raw);
  if (!parsed || !/^mongodb(\+srv)?:$/.test(parsed.protocol)) {
    throw new Error('TEST_MONGODB_URI must be a mongodb:// or mongodb+srv:// URL');
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'rain_ai_test';
  if (!dbName.endsWith('_test')) {
    throw new Error(`TEST_MONGODB_URI database "${dbName}" must end with "_test"`);
  }
  const allowed = new Set([...LOCAL_HOSTS, ...allowedHosts]);
  if (!allowed.has(parsed.hostname)) {
    throw new Error(`TEST_MONGODB_URI host "${parsed.hostname}" is not a local or disposable host`);
  }
  return dbName;
}

describe('MongoDB AI analysis integration', () => {
  let container: StartedTestContainer | undefined;
  let repo: AiAnalysisRepository;
  let closeMongo: () => Promise<void>;
  let cleanCollection: () => Promise<void>;

  beforeAll(async () => {
    let uri = process.env.TEST_MONGODB_URI;
    let dbName: string;

    if (uri) {
      dbName = assertSafeTestMongoUri(uri);
    } else {
      try {
        container = await new GenericContainer('mongo:7.0')
          .withExposedPorts(27017)
          .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
          .start();
      } catch (err) {
        throw new Error(
          'MongoDB integration tests need Docker (for Testcontainers) or TEST_MONGODB_URI pointing at a local MongoDB database whose name ends in "_test".',
          { cause: err },
        );
      }
      const host = container.getHost();
      const port = container.getMappedPort(27017);
      uri = `mongodb://${host}:${port}/rain_ai_test`;
      dbName = assertSafeTestMongoUri(uri, [host]);
    }

    const handle = await connectAiMongo(uri, dbName);
    repo = createAiAnalysisRepository(handle.connection);
    const model = getIncidentAiAnalysisModel(handle.connection);
    cleanCollection = async () => {
      await model.deleteMany({});
    };
    closeMongo = handle.close;
  }, 180_000);

  afterAll(async () => {
    await closeMongo?.();
    await container?.stop();
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
    expect(await repo.findById(alice, incidentId, created.id)).not.toBeNull();
    expect(await repo.findById(bob, incidentId, created.id)).toBeNull();

    const updated = await repo.update(alice, incidentId, created.id, {
      operatorNotes: 'Verified with provider',
      helpful: true,
    });
    expect(updated?.operatorNotes).toBe('Verified with provider');
    expect(updated?.helpful).toBe(true);
    expect(await repo.update(bob, incidentId, created.id, { helpful: false })).toBeNull();

    expect(await repo.remove(bob, incidentId, created.id)).toBe(false);
    expect(await repo.remove(alice, incidentId, created.id)).toBe(true);
    expect(await repo.findById(alice, incidentId, created.id)).toBeNull();
  });
});
