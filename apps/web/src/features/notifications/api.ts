import {
  NotificationDeliveryDetailSchema,
  NotificationListResponseSchema,
  NotificationSettingsSchema,
  NotificationSettingsUpdateResponseSchema,
  type NotificationChannel,
  type NotificationStatus,
  type UpdateNotificationSettingsInput,
} from '@rain/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/auth-context';

export const NOTIFICATION_PAGE_SIZE = 25;
/** Delivery status changes in the worker, so history refreshes on its own. */
export const NOTIFICATION_REFRESH_MS = 15_000;

export interface NotificationFilters {
  status?: NotificationStatus | undefined;
  channel?: NotificationChannel | undefined;
  monitorId?: string | undefined;
}

export const notificationKeys = {
  all: ['notifications'] as const,
  settings: (monitorId: string) => [...notificationKeys.all, 'settings', monitorId] as const,
  lists: () => [...notificationKeys.all, 'list'] as const,
  list: (f: NotificationFilters) => [...notificationKeys.lists(), f] as const,
  detail: (id: string) => [...notificationKeys.all, 'detail', id] as const,
};

const settingsPath = (monitorId: string) =>
  `/api/v1/monitors/${encodeURIComponent(monitorId)}/notifications`;

export function useNotificationSettings(monitorId: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: notificationKeys.settings(monitorId),
    queryFn: () => api.get(settingsPath(monitorId), NotificationSettingsSchema),
  });
}

export function useUpdateNotificationSettings(monitorId: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateNotificationSettingsInput) =>
      api.put(settingsPath(monitorId), NotificationSettingsUpdateResponseSchema, patch),
    onSuccess: (result) => {
      queryClient.setQueryData(notificationKeys.settings(monitorId), result.settings);
    },
    meta: { inlineErrors: true },
  });
}

export function notificationListPath(f: NotificationFilters, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(NOTIFICATION_PAGE_SIZE) });
  if (f.status) query.set('status', f.status);
  if (f.channel) query.set('channel', f.channel);
  if (f.monitorId) query.set('monitorId', f.monitorId);
  if (cursor) query.set('cursor', cursor);
  return `/api/v1/notifications?${query.toString()}`;
}

export function useNotificationList(filters: NotificationFilters) {
  const { api } = useAuth();
  return useInfiniteQuery({
    queryKey: notificationKeys.list(filters),
    queryFn: ({ pageParam }) =>
      api.get(notificationListPath(filters, pageParam), NotificationListResponseSchema),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: NOTIFICATION_REFRESH_MS,
  });
}

export function useNotification(id: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: notificationKeys.detail(id),
    queryFn: () =>
      api.get(`/api/v1/notifications/${encodeURIComponent(id)}`, NotificationDeliveryDetailSchema),
    refetchInterval: NOTIFICATION_REFRESH_MS,
  });
}

export function useRetryNotification(id: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(
        `/api/v1/notifications/${encodeURIComponent(id)}/retry`,
        NotificationDeliveryDetailSchema,
      ),
    onSuccess: async (detail) => {
      queryClient.setQueryData(notificationKeys.detail(id), detail);
      await queryClient.invalidateQueries({ queryKey: notificationKeys.lists() });
    },
    meta: { inlineErrors: true },
  });
}
