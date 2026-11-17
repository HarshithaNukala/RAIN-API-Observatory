import type { MonitorService } from '../monitors/monitor-service.js';

const METHODS = [
  'create',
  'list',
  'get',
  'update',
  'updateHeaders',
  'pause',
  'resume',
  'remove',
] as const;

/** A MonitorService whose methods fail loudly unless a test supplies them. */
export function stubMonitorService(overrides: Partial<MonitorService> = {}): MonitorService {
  const unexpected = Object.fromEntries(
    METHODS.map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected call to MonitorService.${name}`)),
    ]),
  ) as unknown as MonitorService;
  return { ...unexpected, ...overrides };
}
