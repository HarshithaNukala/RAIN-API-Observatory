import type {
  AiAnalysisDocument,
  AiAnalysisListResponse,
  AiCapability,
  GenerateAiAnalysis,
  UpdateAiAnalysis,
} from '@rain/shared';
import { AppError } from '../errors.js';
import type { IncidentRepository } from '../incidents/incident-repository.js';
import { incidentNotFound } from '../incidents/incident-service.js';
import type { AiAnalysisRepository } from './ai-analysis-repository.js';
import type { GeminiClient } from './gemini-client.js';
import { buildIncidentAnalysisPrompt } from './prompt-builder.js';

export interface AiAnalysisService {
  capability(): AiCapability;
  list(ownerId: string, incidentId: string, limit: number): Promise<AiAnalysisListResponse>;
  generate(
    ownerId: string,
    incidentId: string,
    input: GenerateAiAnalysis,
  ): Promise<AiAnalysisDocument>;
  update(
    ownerId: string,
    incidentId: string,
    analysisId: string,
    patch: UpdateAiAnalysis,
  ): Promise<AiAnalysisDocument>;
  remove(ownerId: string, incidentId: string, analysisId: string): Promise<void>;
}

export interface AiAnalysisServiceDependencies {
  incidentRepository: IncidentRepository;
  aiRepository: AiAnalysisRepository | null;
  geminiClient: GeminiClient | null;
}

export const aiAnalysisNotFound = () =>
  new AppError(404, 'AI_ANALYSIS_NOT_FOUND', 'AI analysis not found');

export function createAiAnalysisService(deps: AiAnalysisServiceDependencies): AiAnalysisService {
  const { incidentRepository, aiRepository, geminiClient } = deps;

  function capability(): AiCapability {
    const geminiConfigured = geminiClient !== null;
    const mongodbConfigured = aiRepository !== null && aiRepository.isReady();
    const available = geminiConfigured && mongodbConfigured;
    let reason: string | null = null;
    if (!geminiConfigured && !mongodbConfigured) {
      reason =
        'AI incident analysis requires GEMINI_API_KEY and MONGODB_URI to be configured on the server.';
    } else if (!geminiConfigured) {
      reason = 'GEMINI_API_KEY is not configured on the server.';
    } else if (!mongodbConfigured) {
      reason = 'MongoDB (MONGODB_URI) is not configured or unavailable on the server.';
    }
    return { available, geminiConfigured, mongodbConfigured, reason };
  }

  async function assertOwnedIncident(ownerId: string, incidentId: string): Promise<void> {
    const found = await incidentRepository.findById(ownerId, incidentId);
    if (!found) throw incidentNotFound();
  }

  function requireMongo(): AiAnalysisRepository {
    if (!aiRepository || !aiRepository.isReady()) {
      throw new AppError(
        503,
        'AI_NOT_CONFIGURED',
        'MongoDB analysis storage is not configured or unavailable.',
      );
    }
    return aiRepository;
  }

  return {
    capability,

    async list(ownerId, incidentId, limit) {
      await assertOwnedIncident(ownerId, incidentId);
      const cap = capability();
      if (!cap.mongodbConfigured || !aiRepository) {
        return { items: [], capability: cap };
      }
      const items = await aiRepository.listByIncident(ownerId, incidentId, limit);
      return { items, capability: cap };
    },

    async generate(ownerId, incidentId, input) {
      const cap = capability();
      if (!cap.available || !geminiClient) {
        throw new AppError(
          503,
          'AI_NOT_CONFIGURED',
          cap.reason ?? 'AI incident analysis is not configured.',
        );
      }
      const repo = requireMongo();
      const context = await incidentRepository.findAnalysisContext(ownerId, incidentId);
      if (!context) throw incidentNotFound();

      const prompt = buildIncidentAnalysisPrompt(context, input.focusQuestion);
      const generated = await geminiClient.analyzeIncident(prompt);

      return repo.create({
        ownerId,
        incidentId,
        monitorId: context.monitor.id,
        promptVersion: prompt.promptVersion,
        model: generated.model,
        focusQuestion: input.focusQuestion ?? null,
        analysis: generated.analysis,
        contextSnapshot: prompt.sanitizedContext,
      });
    },

    async update(ownerId, incidentId, analysisId, patch) {
      await assertOwnedIncident(ownerId, incidentId);
      const repo = requireMongo();
      const updated = await repo.update(ownerId, incidentId, analysisId, patch);
      if (!updated) throw aiAnalysisNotFound();
      return updated;
    },

    async remove(ownerId, incidentId, analysisId) {
      await assertOwnedIncident(ownerId, incidentId);
      const repo = requireMongo();
      const deleted = await repo.remove(ownerId, incidentId, analysisId);
      if (!deleted) throw aiAnalysisNotFound();
    },
  };
}
