import {
  AI_CONFIDENCE_LEVELS,
  AiStructuredAnalysisSchema,
  type AiStructuredAnalysis,
} from '@rain/shared';
import { AppError } from '../errors.js';
import type { BuiltIncidentPrompt } from './prompt-builder.js';

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface GeminiAnalysisResult {
  model: string;
  analysis: AiStructuredAnalysis;
}

export interface GeminiClient {
  readonly model: string;
  analyzeIncident(prompt: BuiltIncidentPrompt): Promise<GeminiAnalysisResult>;
}

/** Gemini OpenAPI-subset JSON schema matching `AiStructuredAnalysisSchema`. */
export const GEMINI_ANALYSIS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: [
    'incidentSummary',
    'potentialCauses',
    'supportingEvidence',
    'suggestedInvestigationSteps',
    'recommendedActions',
    'confidenceLevel',
    'limitations',
  ],
  properties: {
    incidentSummary: { type: 'STRING' },
    potentialCauses: { type: 'ARRAY', items: { type: 'STRING' } },
    supportingEvidence: { type: 'ARRAY', items: { type: 'STRING' } },
    suggestedInvestigationSteps: { type: 'ARRAY', items: { type: 'STRING' } },
    recommendedActions: { type: 'ARRAY', items: { type: 'STRING' } },
    confidenceLevel: { type: 'STRING', enum: [...AI_CONFIDENCE_LEVELS] },
    limitations: { type: 'ARRAY', items: { type: 'STRING' } },
  },
} as const;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return match ? (match[1] ?? '').trim() : trimmed;
}

/**
 * Backend-only Google Gemini API adapter.
 *
 * Uses `x-goog-api-key` header (never query string) and validates every JSON response against
 * `AiStructuredAnalysisSchema`. Timeouts and malformed model outputs become safe `AI_PROVIDER_ERROR`s
 * without leaking credentials.
 */
export function createGeminiClient(options: GeminiClientOptions): GeminiClient {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
    /\/+$/,
    '',
  );
  const doFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    model: options.model,

    async analyzeIncident(prompt) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const endpoint = `${baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`;

      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': options.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: prompt.systemInstruction }],
            },
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt.userPrompt }],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
              responseSchema: GEMINI_ANALYSIS_RESPONSE_SCHEMA,
            },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'AbortError';
        throw new AppError(
          502,
          'AI_PROVIDER_ERROR',
          timedOut
            ? 'AI analysis request timed out while waiting for Gemini.'
            : 'Could not reach the Gemini AI service.',
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        throw new AppError(
          502,
          'AI_PROVIDER_ERROR',
          `Gemini AI returned an error response (HTTP ${res.status}).`,
        );
      }

      const raw = (await res.json().catch(() => undefined)) as
        | {
            candidates?: Array<{
              finishReason?: string;
              content?: { parts?: Array<{ text?: string }> };
            }>;
          }
        | undefined;

      const candidate = raw?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text.trim()) {
        const reason = candidate?.finishReason ? ` (${candidate.finishReason})` : '';
        throw new AppError(
          502,
          'AI_PROVIDER_ERROR',
          `Gemini AI returned an empty analysis response${reason}.`,
        );
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(stripCodeFences(text));
      } catch {
        throw new AppError(
          502,
          'AI_PROVIDER_ERROR',
          'Gemini AI returned invalid JSON that failed structured parsing.',
        );
      }

      const validated = AiStructuredAnalysisSchema.safeParse(decoded);
      if (!validated.success) {
        throw new AppError(
          502,
          'AI_PROVIDER_ERROR',
          'Gemini AI response did not match the required structured analysis schema.',
        );
      }

      return {
        model: options.model,
        analysis: validated.data,
      };
    },
  };
}
