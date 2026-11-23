import type { NotificationService } from '../notifications/notification-service.js';

const METHODS = ['getSettings', 'updateSettings', 'list', 'get', 'retry'] as const;

/** A NotificationService whose methods fail loudly unless a test supplies them. */
export function stubNotificationService(
  overrides: Partial<NotificationService> = {},
): NotificationService {
  const unexpected = Object.fromEntries(
    METHODS.map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected call to NotificationService.${name}`)),
    ]),
  ) as unknown as NotificationService;
  return { ...unexpected, ...overrides };
}
