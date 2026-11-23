/**
 * Encryption contexts (AES-GCM additional authenticated data) that bind each stored secret to the
 * row it was written for. Writers (the monitor service) and readers (the executor) must agree.
 */
export const bodyContext = (monitorId: string) => `monitor-body:${monitorId}`;

export const headerContext = (monitorId: string, name: string) =>
  `monitor-header:${monitorId}:${name.toLowerCase()}`;

/** The webhook signing secret of a monitor's notification settings. */
export const webhookSecretContext = (monitorId: string) =>
  `notification-webhook-secret:${monitorId}`;

/** The optional authentication header sent to a monitor's notification webhook. */
export const webhookHeaderContext = (monitorId: string, name: string) =>
  `notification-webhook-header:${monitorId}:${name.toLowerCase()}`;
