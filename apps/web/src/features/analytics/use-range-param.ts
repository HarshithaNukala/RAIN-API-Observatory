import { ANALYTICS_RANGES, type AnalyticsRange } from '@rain/shared';
import { useSearchParams } from 'react-router';

/** The selected range, kept in the URL (?range=7d) so it survives reloads and links. */
export function useRangeParam(): [AnalyticsRange, (range: AnalyticsRange) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('range');
  const range = (ANALYTICS_RANGES as readonly string[]).includes(raw ?? '')
    ? (raw as AnalyticsRange)
    : '24h';
  const set = (next: AnalyticsRange) => {
    const updated = new URLSearchParams(params);
    if (next === '24h') updated.delete('range');
    else updated.set('range', next);
    setParams(updated, { replace: true });
  };
  return [range, set];
}
