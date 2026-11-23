import type { StatusPageService } from '../status-pages/status-page-service.js';

const METHODS = [
  'create',
  'list',
  'get',
  'update',
  'setPublished',
  'remove',
  'addMonitor',
  'removeMonitor',
  'renameMonitor',
  'reorderMonitors',
  'preview',
  'publicView',
] as const;

/** A StatusPageService whose methods fail loudly unless a test supplies them. */
export function stubStatusPageService(
  overrides: Partial<StatusPageService> = {},
): StatusPageService {
  const unexpected = Object.fromEntries(
    METHODS.map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected call to StatusPageService.${name}`)),
    ]),
  ) as unknown as StatusPageService;
  return { ...unexpected, ...overrides };
}
