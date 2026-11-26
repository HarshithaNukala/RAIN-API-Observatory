import { z } from 'zod';
import { IncidentSeveritySchema, IncidentStatusSchema } from './incident.js';

/**
 * Shared Zod contracts for AI-powered incident analysis.
 *
 * Analyses are advisory documents persisted in MongoDB. They never mutate monitor status,
 * incident lifecycle or notification configuration.
 */

export const AI_ANALYSIS_PROMPT_VERSION = 'incident-analysis-v1' as const;

export const AI_CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiConfidenceLevel = (typeof AI_CONFIDENCE_LEVELS)[number];
export const AiConfidenceLevelSchema = z.enum(AI_CONFIDENCE_LEVELS);

export const AI_ANALYSIS_LIMITS = {
  focusQuestionMaxLength: 500,
  operatorNotesMaxLength: 1000,
  summaryMaxLength: 2000,
  itemMaxLength: 500,
  maxItemsPerSection: 8,
  historyLimit: { default: 10, max: 50 },
} as const;

const timestamp = z.iso.datetime({ offset: true });

const analysisLine = z
  .string()
  .trim()
  .min(1, 'Analysis entry cannot be empty')
  .max(AI_ANALYSIS_LIMITS.itemMaxLength);

const analysisList = z
  .array(analysisLine)
  .min(1, 'At least one entry is required')
  .max(AI_ANALYSIS_LIMITS.maxItemsPerSection);

/**
 * Strict structured output schema enforced on Google Gemini responses before persisting or
 * returning an analysis.
 */
export const AiStructuredAnalysisSchema = z.strictObject({
  incidentSummary: z
    .string()
    .trim()
    .min(1, 'Incident summary is required')
    .max(AI_ANALYSIS_LIMITS.summaryMaxLength),
  potentialCauses: analysisList,
  supportingEvidence: analysisList,
  suggestedInvestigationSteps: analysisList,
  recommendedActions: analysisList,
  confidenceLevel: AiConfidenceLevelSchema,
  limitations: analysisList,
});
export type AiStructuredAnalysis = z.infer<typeof AiStructuredAnalysisSchema>;

export const AiContextSnapshotSchema = z.object({
  monitorName: z.string(),
  incidentStatus: IncidentStatusSchema,
  incidentSeverity: IncidentSeveritySchema,
  checksAnalyzed: z.number().int().min(0),
  failedChecksInWindow: z.number().int().min(0),
  avgLatencyMs: z.number().nullable(),
});
export type AiContextSnapshot = z.infer<typeof AiContextSnapshotSchema>;

export const AiCapabilitySchema = z.object({
  available: z.boolean(),
  geminiConfigured: z.boolean(),
  mongodbConfigured: z.boolean(),
  reason: z.string().nullable(),
});
export type AiCapability = z.infer<typeof AiCapabilitySchema>;

export const AiAnalysisDocumentSchema = z.object({
  id: z.string().min(1),
  incidentId: z.uuid(),
  monitorId: z.uuid(),
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  focusQuestion: z.string().nullable(),
  analysis: AiStructuredAnalysisSchema,
  operatorNotes: z.string().nullable(),
  helpful: z.boolean().nullable(),
  contextSnapshot: AiContextSnapshotSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AiAnalysisDocument = z.infer<typeof AiAnalysisDocumentSchema>;

export const AiAnalysisListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AI_ANALYSIS_LIMITS.historyLimit.max)
    .default(AI_ANALYSIS_LIMITS.historyLimit.default),
});
export type AiAnalysisListQuery = z.infer<typeof AiAnalysisListQuerySchema>;

export const AiAnalysisListResponseSchema = z.object({
  items: z.array(AiAnalysisDocumentSchema),
  capability: AiCapabilitySchema,
});
export type AiAnalysisListResponse = z.infer<typeof AiAnalysisListResponseSchema>;

const optionalFocusQuestion = z
  .string()
  .trim()
  .max(
    AI_ANALYSIS_LIMITS.focusQuestionMaxLength,
    `Focus question must be at most ${AI_ANALYSIS_LIMITS.focusQuestionMaxLength} characters`,
  )
  .transform((v) => (v === '' ? undefined : v));

export const GenerateAiAnalysisSchema = z.strictObject({
  focusQuestion: optionalFocusQuestion.optional(),
});
export type GenerateAiAnalysis = z.infer<typeof GenerateAiAnalysisSchema>;
export type GenerateAiAnalysisInput = z.input<typeof GenerateAiAnalysisSchema>;

const operatorNotes = z
  .string()
  .trim()
  .max(
    AI_ANALYSIS_LIMITS.operatorNotesMaxLength,
    `Notes must be at most ${AI_ANALYSIS_LIMITS.operatorNotesMaxLength} characters`,
  )
  .transform((v) => (v === '' ? null : v));

export const UpdateAiAnalysisSchema = z
  .strictObject({
    operatorNotes: operatorNotes.nullable().optional(),
    helpful: z.boolean().nullable().optional(),
  })
  .refine((v) => v.operatorNotes !== undefined || v.helpful !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateAiAnalysis = z.infer<typeof UpdateAiAnalysisSchema>;
export type UpdateAiAnalysisInput = z.input<typeof UpdateAiAnalysisSchema>;
