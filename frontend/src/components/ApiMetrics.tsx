import { useState } from 'react';
import { useApiMetrics, useLatencySeries, useSuccessFailureSeries } from '../services/metrics';
import type { TimeWindow } from '../types/metrics';
import { LatencyChart } from './LatencyChart';
import { SuccessFailureChart } from './SuccessFailureChart';

export const ApiMetrics = ({ apiId }: { apiId: number }) => {
  const [window, setWindow] = useState<TimeWindow>('24h');
  const { data: metrics, isLoading: isMetricsLoading } = useApiMetrics(apiId, window);
  const { data: latencySeries } = useLatencySeries(apiId, window);
  const { data: successFailureSeries } = useSuccessFailureSeries(apiId, window);

  if (isMetricsLoading) return <div className="text-sm text-slate-500">Loading metrics...</div>;
  if (!metrics) return <div className="text-sm text-red-500">Failed to load metrics.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-slate-800">Telemetry</h3>
        <select
          value={window}
          onChange={(e) => setWindow(e.target.value as TimeWindow)}
          className="text-sm px-3 py-1.5 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="1h">Last 1 Hour</option>
          <option value="6h">Last 6 Hours</option>
          <option value="24h">Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
          <option value="30d">Last 30 Days</option>
        </select>
      </div>

      {metrics.totalChecks === 0 ? (
        <div className="p-8 text-center text-slate-500 bg-slate-50 rounded-xl border border-slate-200">
          No monitoring data yet.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-center">
              <span className="block text-xs text-slate-500 mb-1">Check-Based Uptime</span>
              <span className="text-xl font-bold text-slate-800">{metrics.uptimePercentage?.toFixed(2)}%</span>
            </div>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-center">
              <span className="block text-xs text-slate-500 mb-1">Avg Latency</span>
              <span className="text-xl font-bold text-slate-800">
                {metrics.averageResponseLatencyMs ? `${Math.round(metrics.averageResponseLatencyMs)}ms` : '-'}
              </span>
            </div>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-center">
              <span className="block text-xs text-slate-500 mb-1">P95 Latency</span>
              <span className="text-xl font-bold text-slate-800">
                {metrics.p95ResponseLatencyMs ? `${Math.round(metrics.p95ResponseLatencyMs)}ms` : '-'}
              </span>
            </div>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-center">
              <span className="block text-xs text-slate-500 mb-1">Total Checks</span>
              <span className="text-xl font-bold text-slate-800">{metrics.totalChecks.toLocaleString()}</span>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h4 className="text-sm font-semibold text-slate-700 mb-4">Latency History</h4>
            {latencySeries && <LatencyChart data={latencySeries} />}
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h4 className="text-sm font-semibold text-slate-700 mb-4">Success & Failure Rate</h4>
            {successFailureSeries && <SuccessFailureChart data={successFailureSeries} />}
          </div>
        </>
      )}
    </div>
  );
};
