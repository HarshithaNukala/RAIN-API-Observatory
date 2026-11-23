import type { IncidentService } from '../incidents/incident-service.js';

const METHODS = ['list', 'counts', 'get', 'events', 'acknowledge', 'update'] as const;

/** An IncidentService whose methods fail loudly unless a test supplies them. */
export function stubIncidentService(overrides: Partial<IncidentService> = {}): IncidentService {
  const unexpected = Object.fromEntries(
    METHODS.map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected call to IncidentService.${name}`)),
    ]),
  ) as unknown as IncidentService;
  return { ...unexpected, ...overrides };
}
