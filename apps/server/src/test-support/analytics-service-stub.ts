import type { AnalyticsService } from '../analytics/analytics-service.js';

/** An AnalyticsService whose methods fail loudly unless a test supplies them. */
export function stubAnalyticsService(overrides: Partial<AnalyticsService> = {}): AnalyticsService {
  return {
    overview: () => Promise.reject(new Error('Unexpected call to AnalyticsService.overview')),
    monitorMetrics: () =>
      Promise.reject(new Error('Unexpected call to AnalyticsService.monitorMetrics')),
    ...overrides,
  };
}
