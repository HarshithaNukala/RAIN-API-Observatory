import {
  AiAnalysisDocumentSchema,
  AiAnalysisListResponseSchema,
  type AiAnalysisDocument,
  type GenerateAiAnalysisInput,
  type UpdateAiAnalysisInput,
} from '@rain/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/auth-context';

export const aiAnalysisKeys = {
  all: ['ai-analyses'] as const,
  list: (incidentId: string) => [...aiAnalysisKeys.all, incidentId] as const,
};

const base = (incidentId: string) =>
  `/api/v1/incidents/${encodeURIComponent(incidentId)}/ai-analyses`;

export function useIncidentAiAnalyses(incidentId: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: aiAnalysisKeys.list(incidentId),
    queryFn: () => api.get(base(incidentId), AiAnalysisListResponseSchema),
  });
}

export function useGenerateIncidentAiAnalysis(incidentId: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateAiAnalysisInput) =>
      api.post(base(incidentId), AiAnalysisDocumentSchema, input),
    onSuccess: (created: AiAnalysisDocument) => {
      queryClient.setQueryData(
        aiAnalysisKeys.list(incidentId),
        (prev: { items: AiAnalysisDocument[]; capability: unknown } | undefined) =>
          prev ? { ...prev, items: [created, ...prev.items] } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: aiAnalysisKeys.list(incidentId) });
    },
    meta: { inlineErrors: true },
  });
}

export function useUpdateIncidentAiAnalysis(incidentId: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ analysisId, patch }: { analysisId: string; patch: UpdateAiAnalysisInput }) =>
      api.patch(
        `${base(incidentId)}/${encodeURIComponent(analysisId)}`,
        AiAnalysisDocumentSchema,
        patch,
      ),
    onSuccess: (updated: AiAnalysisDocument) => {
      queryClient.setQueryData(
        aiAnalysisKeys.list(incidentId),
        (prev: { items: AiAnalysisDocument[]; capability: unknown } | undefined) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((item) => (item.id === updated.id ? updated : item)),
              }
            : prev,
      );
    },
    meta: { inlineErrors: true },
  });
}

export function useDeleteIncidentAiAnalysis(incidentId: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: string) =>
      api.delete(`${base(incidentId)}/${encodeURIComponent(analysisId)}`),
    onSuccess: (_data, analysisId) => {
      queryClient.setQueryData(
        aiAnalysisKeys.list(incidentId),
        (prev: { items: AiAnalysisDocument[]; capability: unknown } | undefined) =>
          prev ? { ...prev, items: prev.items.filter((item) => item.id !== analysisId) } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: aiAnalysisKeys.list(incidentId) });
    },
    meta: { inlineErrors: true },
  });
}
