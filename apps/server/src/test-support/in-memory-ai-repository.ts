import type { AiAnalysisDocument } from '@rain/shared';
import { Types } from 'mongoose';
import type { AiAnalysisRepository } from '../ai/ai-analysis-repository.js';

/**
 * In-memory stand-in for `AiAnalysisRepository` used in unit tests without a running MongoDB.
 * Enforces identical `ownerId` + `incidentId` scoping and ObjectId syntax checks.
 */
export function createInMemoryAiAnalysisRepository(
  options: { ready?: boolean } = {},
): AiAnalysisRepository & { docs: Array<AiAnalysisDocument & { ownerId: string }> } {
  const docs: Array<AiAnalysisDocument & { ownerId: string }> = [];
  const ready = options.ready ?? true;

  const stripOwner = ({ ownerId: _owner, ...rest }: AiAnalysisDocument & { ownerId: string }) => ({
    ...rest,
    analysis: {
      ...rest.analysis,
      potentialCauses: [...rest.analysis.potentialCauses],
      supportingEvidence: [...rest.analysis.supportingEvidence],
      suggestedInvestigationSteps: [...rest.analysis.suggestedInvestigationSteps],
      recommendedActions: [...rest.analysis.recommendedActions],
      limitations: [...rest.analysis.limitations],
    },
    contextSnapshot: { ...rest.contextSnapshot },
  });

  return {
    docs,
    isReady: () => ready,

    async create(input) {
      const now = new Date().toISOString();
      const doc: AiAnalysisDocument & { ownerId: string } = {
        id: new Types.ObjectId().toHexString(),
        ownerId: input.ownerId,
        incidentId: input.incidentId,
        monitorId: input.monitorId,
        promptVersion: input.promptVersion,
        model: input.model,
        focusQuestion: input.focusQuestion ?? null,
        analysis: { ...input.analysis },
        operatorNotes: null,
        helpful: null,
        contextSnapshot: { ...input.contextSnapshot },
        createdAt: now,
        updatedAt: now,
      };
      docs.push(doc);
      return stripOwner(doc);
    },

    async listByIncident(ownerId, incidentId, limit) {
      return docs
        .filter((d) => d.ownerId === ownerId && d.incidentId === incidentId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(stripOwner);
    },

    async findById(ownerId, incidentId, analysisId) {
      if (!Types.ObjectId.isValid(analysisId)) return null;
      const found = docs.find(
        (d) => d.id === analysisId && d.ownerId === ownerId && d.incidentId === incidentId,
      );
      return found ? stripOwner(found) : null;
    },

    async update(ownerId, incidentId, analysisId, patch) {
      if (!Types.ObjectId.isValid(analysisId)) return null;
      const found = docs.find(
        (d) => d.id === analysisId && d.ownerId === ownerId && d.incidentId === incidentId,
      );
      if (!found) return null;
      if (patch.operatorNotes !== undefined) found.operatorNotes = patch.operatorNotes;
      if (patch.helpful !== undefined) found.helpful = patch.helpful;
      found.updatedAt = new Date().toISOString();
      return stripOwner(found);
    },

    async remove(ownerId, incidentId, analysisId) {
      if (!Types.ObjectId.isValid(analysisId)) return false;
      const idx = docs.findIndex(
        (d) => d.id === analysisId && d.ownerId === ownerId && d.incidentId === incidentId,
      );
      if (idx === -1) return false;
      docs.splice(idx, 1);
      return true;
    },
  };
}
