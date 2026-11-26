import {
  AI_ANALYSIS_LIMITS,
  AI_CONFIDENCE_LEVELS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type AiConfidenceLevel,
  type IncidentSeverity,
  type IncidentStatus,
} from '@rain/shared';
import { Schema, type Connection, type Model, type Types } from 'mongoose';

const nonEmptyArray = (min: number, max: number) => ({
  validator: (arr: unknown): boolean =>
    Array.isArray(arr) &&
    arr.length >= min &&
    arr.length <= max &&
    arr.every((item) => typeof item === 'string' && item.trim().length > 0),
  message: `Must contain between ${min} and ${max} non-empty entries`,
});

const itemString = {
  type: String,
  trim: true,
  minlength: 1,
  maxlength: AI_ANALYSIS_LIMITS.itemMaxLength,
};

export interface IncidentAiAnalysisAttrs {
  ownerId: string;
  incidentId: string;
  monitorId: string;
  promptVersion: string;
  model: string;
  focusQuestion: string | null;
  analysis: {
    incidentSummary: string;
    potentialCauses: string[];
    supportingEvidence: string[];
    suggestedInvestigationSteps: string[];
    recommendedActions: string[];
    confidenceLevel: AiConfidenceLevel;
    limitations: string[];
  };
  operatorNotes: string | null;
  helpful: boolean | null;
  contextSnapshot: {
    monitorName: string;
    incidentStatus: IncidentStatus;
    incidentSeverity: IncidentSeverity;
    checksAnalyzed: number;
    failedChecksInWindow: number;
    avgLatencyMs: number | null;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IncidentAiAnalysisDoc extends IncidentAiAnalysisAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const structuredAnalysisSubSchema = new Schema(
  {
    incidentSummary: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: AI_ANALYSIS_LIMITS.summaryMaxLength,
    },
    potentialCauses: {
      type: [itemString],
      required: true,
      validate: nonEmptyArray(1, AI_ANALYSIS_LIMITS.maxItemsPerSection),
    },
    supportingEvidence: {
      type: [itemString],
      required: true,
      validate: nonEmptyArray(1, AI_ANALYSIS_LIMITS.maxItemsPerSection),
    },
    suggestedInvestigationSteps: {
      type: [itemString],
      required: true,
      validate: nonEmptyArray(1, AI_ANALYSIS_LIMITS.maxItemsPerSection),
    },
    recommendedActions: {
      type: [itemString],
      required: true,
      validate: nonEmptyArray(1, AI_ANALYSIS_LIMITS.maxItemsPerSection),
    },
    confidenceLevel: {
      type: String,
      required: true,
      enum: AI_CONFIDENCE_LEVELS,
    },
    limitations: {
      type: [itemString],
      required: true,
      validate: nonEmptyArray(1, AI_ANALYSIS_LIMITS.maxItemsPerSection),
    },
  },
  { _id: false, strict: 'throw' },
);

const contextSnapshotSubSchema = new Schema(
  {
    monitorName: { type: String, required: true, trim: true, maxlength: 200 },
    incidentStatus: { type: String, required: true, enum: INCIDENT_STATUSES },
    incidentSeverity: { type: String, required: true, enum: INCIDENT_SEVERITIES },
    checksAnalyzed: { type: Number, required: true, min: 0 },
    failedChecksInWindow: { type: Number, required: true, min: 0 },
    avgLatencyMs: { type: Number, default: null, min: 0 },
  },
  { _id: false, strict: 'throw' },
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mongoose schema for AI incident analysis history.
 *
 * Security & modelling notes:
 * - `strict: 'throw'` rejects unexpected properties so credentials, raw request headers, or
 *   encrypted payloads can never be written into MongoDB documents.
 * - Compound index `{ ownerId: 1, incidentId: 1, createdAt: -1 }` serves owner-scoped history.
 */
export const IncidentAiAnalysisSchema = new Schema<IncidentAiAnalysisDoc>(
  {
    ownerId: {
      type: String,
      required: true,
      trim: true,
      match: [UUID_REGEX, 'ownerId must be a UUID'],
    },
    incidentId: {
      type: String,
      required: true,
      trim: true,
      match: [UUID_REGEX, 'incidentId must be a UUID'],
    },
    monitorId: {
      type: String,
      required: true,
      trim: true,
      match: [UUID_REGEX, 'monitorId must be a UUID'],
    },
    promptVersion: { type: String, required: true, trim: true, minlength: 1, maxlength: 64 },
    model: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    focusQuestion: {
      type: String,
      default: null,
      trim: true,
      maxlength: AI_ANALYSIS_LIMITS.focusQuestionMaxLength,
    },
    analysis: { type: structuredAnalysisSubSchema, required: true },
    operatorNotes: {
      type: String,
      default: null,
      trim: true,
      maxlength: AI_ANALYSIS_LIMITS.operatorNotesMaxLength,
    },
    helpful: { type: Boolean, default: null },
    contextSnapshot: { type: contextSnapshotSubSchema, required: true },
  },
  {
    collection: 'incident_ai_analyses',
    timestamps: true,
    strict: 'throw',
  },
);

IncidentAiAnalysisSchema.index({ ownerId: 1, incidentId: 1, createdAt: -1 });
IncidentAiAnalysisSchema.index({ ownerId: 1, _id: 1 });

export type IncidentAiAnalysisModel = Model<IncidentAiAnalysisDoc>;

export function getIncidentAiAnalysisModel(connection: Connection): IncidentAiAnalysisModel {
  return (
    (connection.models['IncidentAiAnalysis'] as IncidentAiAnalysisModel | undefined) ??
    connection.model<IncidentAiAnalysisDoc>('IncidentAiAnalysis', IncidentAiAnalysisSchema)
  );
}
