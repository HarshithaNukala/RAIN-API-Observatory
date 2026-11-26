import type { AiAnalysisDocument, UpdateAiAnalysis } from '@rain/shared';
import mongoose, { type Connection } from 'mongoose';
import {
  getIncidentAiAnalysisModel,
  type IncidentAiAnalysisAttrs,
  type IncidentAiAnalysisDoc,
  type IncidentAiAnalysisModel,
} from './ai-analysis-model.js';

export type CreateAiAnalysisInput = Omit<
  IncidentAiAnalysisAttrs,
  'operatorNotes' | 'helpful' | 'createdAt' | 'updatedAt'
>;

export interface AiAnalysisRepository {
  isReady(): boolean;
  create(input: CreateAiAnalysisInput): Promise<AiAnalysisDocument>;
  listByIncident(ownerId: string, incidentId: string, limit: number): Promise<AiAnalysisDocument[]>;
  findById(
    ownerId: string,
    incidentId: string,
    analysisId: string,
  ): Promise<AiAnalysisDocument | null>;
  update(
    ownerId: string,
    incidentId: string,
    analysisId: string,
    patch: UpdateAiAnalysis,
  ): Promise<AiAnalysisDocument | null>;
  remove(ownerId: string, incidentId: string, analysisId: string): Promise<boolean>;
}

function toDto(doc: IncidentAiAnalysisDoc): AiAnalysisDocument {
  return {
    id: doc._id.toHexString(),
    incidentId: doc.incidentId,
    monitorId: doc.monitorId,
    promptVersion: doc.promptVersion,
    model: doc.model,
    focusQuestion: doc.focusQuestion ?? null,
    analysis: {
      incidentSummary: doc.analysis.incidentSummary,
      potentialCauses: [...doc.analysis.potentialCauses],
      supportingEvidence: [...doc.analysis.supportingEvidence],
      suggestedInvestigationSteps: [...doc.analysis.suggestedInvestigationSteps],
      recommendedActions: [...doc.analysis.recommendedActions],
      confidenceLevel: doc.analysis.confidenceLevel,
      limitations: [...doc.analysis.limitations],
    },
    operatorNotes: doc.operatorNotes ?? null,
    helpful: doc.helpful ?? null,
    contextSnapshot: {
      monitorName: doc.contextSnapshot.monitorName,
      incidentStatus: doc.contextSnapshot.incidentStatus,
      incidentSeverity: doc.contextSnapshot.incidentSeverity,
      checksAnalyzed: doc.contextSnapshot.checksAnalyzed,
      failedChecksInWindow: doc.contextSnapshot.failedChecksInWindow,
      avgLatencyMs: doc.contextSnapshot.avgLatencyMs ?? null,
    },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function connectAiMongo(
  uri: string,
  dbName: string,
): Promise<{ connection: Connection; close: () => Promise<void> }> {
  const connection = await mongoose
    .createConnection(uri, {
      dbName,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    })
    .asPromise();
  const model = getIncidentAiAnalysisModel(connection);
  await model.createIndexes();
  return {
    connection,
    close: () => connection.close(),
  };
}

/**
 * MongoDB CRUD repository backed by Mongoose.
 *
 * Every query is strictly scoped by `ownerId` and `incidentId` so one tenant can never read,
 * modify or delete another user's analyses.
 */
export function createAiAnalysisRepository(connection: Connection): AiAnalysisRepository {
  const Model: IncidentAiAnalysisModel = getIncidentAiAnalysisModel(connection);

  const validObjectId = (id: string) => mongoose.Types.ObjectId.isValid(id);

  return {
    isReady: () => connection.readyState === 1,

    async create(input) {
      const created = await Model.create({
        ...input,
        operatorNotes: null,
        helpful: null,
      });
      return toDto(created);
    },

    async listByIncident(ownerId, incidentId, limit) {
      const docs = await Model.find({ ownerId, incidentId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .lean<IncidentAiAnalysisDoc[]>();
      return docs.map(toDto);
    },

    async findById(ownerId, incidentId, analysisId) {
      if (!validObjectId(analysisId)) return null;
      const doc = await Model.findOne({
        _id: analysisId,
        ownerId,
        incidentId,
      }).lean<IncidentAiAnalysisDoc | null>();
      return doc ? toDto(doc) : null;
    },

    async update(ownerId, incidentId, analysisId, patch) {
      if (!validObjectId(analysisId)) return null;
      const updates: Record<string, unknown> = {};
      if (patch.operatorNotes !== undefined) updates.operatorNotes = patch.operatorNotes;
      if (patch.helpful !== undefined) updates.helpful = patch.helpful;

      const updated = await Model.findOneAndUpdate(
        { _id: analysisId, ownerId, incidentId },
        { $set: updates },
        { returnDocument: 'after', runValidators: true },
      ).lean<IncidentAiAnalysisDoc | null>();
      return updated ? toDto(updated) : null;
    },

    async remove(ownerId, incidentId, analysisId) {
      if (!validObjectId(analysisId)) return false;
      const res = await Model.deleteOne({ _id: analysisId, ownerId, incidentId });
      return res.deletedCount === 1;
    },
  };
}
