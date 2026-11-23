import {
  PublicStatusPageSchema,
  StatusPageListSchema,
  StatusPageSchema,
  type AddStatusPageMonitor,
  type CreateStatusPageInput,
  type StatusPage,
  type UpdateStatusPageInput,
} from '@rain/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/auth-context';

/** The public page's own refresh, so an open status page stays current. */
export const PUBLIC_REFRESH_MS = 60_000;

export const statusPageKeys = {
  all: ['status-pages'] as const,
  list: () => [...statusPageKeys.all, 'list'] as const,
  detail: (id: string) => [...statusPageKeys.all, 'detail', id] as const,
  preview: (id: string) => [...statusPageKeys.all, 'preview', id] as const,
  public: (slug: string) => ['public-status', slug] as const,
};

const base = '/api/v1/status-pages';
const path = (id: string, suffix = '') => `${base}/${encodeURIComponent(id)}${suffix}`;

/** The public address of a page on this deployment. */
export const publicUrl = (slug: string) => `${window.location.origin}/status/${slug}`;

export function useStatusPages() {
  const { api } = useAuth();
  return useQuery({
    queryKey: statusPageKeys.list(),
    queryFn: () => api.get(base, StatusPageListSchema),
  });
}

export function useStatusPage(id: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: statusPageKeys.detail(id),
    queryFn: () => api.get(path(id), StatusPageSchema),
  });
}

export function useStatusPagePreview(id: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: statusPageKeys.preview(id),
    queryFn: () => api.get(path(id, '/preview'), PublicStatusPageSchema),
  });
}

/** No authentication is needed; the client simply sends none when signed out. */
export function usePublicStatusPage(slug: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: statusPageKeys.public(slug),
    queryFn: () =>
      api.get(`/api/v1/public/status-pages/${encodeURIComponent(slug)}`, PublicStatusPageSchema),
    refetchInterval: PUBLIC_REFRESH_MS,
    retry: false,
  });
}

/** After a change: keep the fresh page, refresh the list and the preview. */
function useChanged() {
  const queryClient = useQueryClient();
  return async (page: StatusPage) => {
    queryClient.setQueryData(statusPageKeys.detail(page.id), page);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: statusPageKeys.list() }),
      queryClient.invalidateQueries({ queryKey: statusPageKeys.preview(page.id) }),
    ]);
  };
}

export function useCreateStatusPage() {
  const { api } = useAuth();
  const changed = useChanged();
  return useMutation({
    mutationFn: (input: CreateStatusPageInput) => api.post(base, StatusPageSchema, input),
    onSuccess: changed,
    meta: { inlineErrors: true },
  });
}

/** Every edit of one page goes through here: info, publication, monitors and their order. */
export function useStatusPageActions(id: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const changed = useChanged();
  const options = { onSuccess: changed, meta: { inlineErrors: true } };
  return {
    update: useMutation({
      mutationFn: (patch: UpdateStatusPageInput) => api.patch(path(id), StatusPageSchema, patch),
      ...options,
    }),
    setPublished: useMutation({
      mutationFn: (published: boolean) =>
        api.post(path(id, published ? '/publish' : '/unpublish'), StatusPageSchema),
      ...options,
    }),
    addMonitor: useMutation({
      mutationFn: (input: AddStatusPageMonitor) =>
        api.post(path(id, '/monitors'), StatusPageSchema, input),
      ...options,
    }),
    renameMonitor: useMutation({
      mutationFn: ({ monitorId, displayName }: { monitorId: string; displayName: string }) =>
        api.patch(path(id, `/monitors/${encodeURIComponent(monitorId)}`), StatusPageSchema, {
          displayName,
        }),
      ...options,
    }),
    removeMonitor: useMutation({
      mutationFn: (monitorId: string) =>
        api.deleteWithBody(
          path(id, `/monitors/${encodeURIComponent(monitorId)}`),
          StatusPageSchema,
        ),
      ...options,
    }),
    reorder: useMutation({
      mutationFn: (monitorIds: string[]) =>
        api.put(path(id, '/monitors/order'), StatusPageSchema, { monitorIds }),
      ...options,
    }),
    remove: useMutation({
      mutationFn: () => api.delete(path(id)),
      onSuccess: async () => {
        queryClient.removeQueries({ queryKey: statusPageKeys.detail(id) });
        await queryClient.invalidateQueries({ queryKey: statusPageKeys.list() });
      },
      meta: { inlineErrors: true },
    }),
  };
}
