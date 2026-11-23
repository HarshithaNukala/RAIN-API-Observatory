import type { NotificationChannel, NotificationEventType, NotificationStatus } from '@rain/shared';

export const EVENT_LABELS: Record<NotificationEventType, string> = {
  INCIDENT_CREATED: 'Incident opened',
  INCIDENT_RESOLVED: 'Incident resolved',
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  EMAIL: 'Email',
  WEBHOOK: 'Webhook',
};

export const STATUS_LABELS: Record<NotificationStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
};

export const STATUS_TONE = {
  PENDING: 'neutral',
  PROCESSING: 'info',
  SENT: 'success',
  FAILED: 'danger',
} as const;
