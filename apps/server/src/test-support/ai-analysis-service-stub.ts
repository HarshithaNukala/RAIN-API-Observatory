import type { AiAnalysisService } from '../ai/ai-analysis-service.js';

const METHODS = ['list', 'generate', 'update', 'remove'] as const;

/** An AiAnalysisService whose methods fail loudly unless a test supplies them. */
export function stubAiAnalysisService(
  overrides: Partial<AiAnalysisService> = {},
): AiAnalysisService {
  const unexpected = Object.fromEntries(
    METHODS.map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected call to AiAnalysisService.${name}`)),
    ]),
  ) as unknown as Omit<AiAnalysisService, 'capability'>;
  return {
    ...unexpected,
    capability: () => ({
      available: true,
      geminiConfigured: true,
      mongodbConfigured: true,
      reason: null,
    }),
    ...overrides,
  };
}
