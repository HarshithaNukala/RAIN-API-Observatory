import { useState } from 'react';
import { useDashboardSummary } from '../services/metrics';
import type { TimeWindow } from '../types/metrics';
import { Activity, CheckCircle, XCircle, AlertCircle, Clock, Server } from 'lucide-react';
import { Link } from 'react-router-dom';

export const DashboardPage = () => {
  const [window, setWindow] = useState<TimeWindow>('24h');
  const { data: summary, isLoading, isError } = useDashboardSummary(window);

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Dashboard</h1>
          <p className="text-slate-500 mt-1">Global platform telemetry and registry overview.</p>
        </div>
        <select
          value={window}
          onChange={(e) => setWindow(e.target.value as TimeWindow)}
          className="px-4 py-2 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-700"
        >
          <option value="1h">Last 1 Hour</option>
          <option value="6h">Last 6 Hours</option>
          <option value="24h">Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
          <option value="30d">Last 30 Days</option>
        </select>
      </div>

      {/* Registry Metrics */}
      <section>
        <h2 className="text-lg font-semibold text-slate-700 mb-4">Registry Overview</h2>
        {isLoading ? (
          <div className="text-slate-500">Loading registry metrics...</div>
        ) : isError || !summary ? (
          <div className="text-red-500">Failed to load registry metrics.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <MetricCard title="Total APIs" value={summary.totalApis} icon={<Server className="w-5 h-5 text-indigo-500" />} />
            <MetricCard title="Healthy APIs" value={summary.healthyApis} icon={<CheckCircle className="w-5 h-5 text-emerald-500" />} />
            <MetricCard title="Degraded APIs" value={summary.degradedApis} icon={<AlertCircle className="w-5 h-5 text-amber-500" />} />
            <MetricCard title="Down APIs" value={summary.downApis} icon={<XCircle className="w-5 h-5 text-red-500" />} />
            <MetricCard title="Enabled APIs" value={summary.enabledApis} icon={<Activity className="w-5 h-5 text-blue-500" />} />
            <MetricCard title="Paused APIs" value={summary.pausedApis} icon={<Clock className="w-5 h-5 text-slate-400" />} />
          </div>
        )}
      </section>

      {/* Telemetry Metrics */}
      <section>
        <h2 className="text-lg font-semibold text-slate-700 mb-4">Global Telemetry ({window})</h2>
        {isLoading ? (
          <div className="text-slate-500">Loading telemetry...</div>
        ) : isError || !summary ? (
          <div className="text-red-500">Failed to load telemetry.</div>
        ) : summary.totalChecks === 0 ? (
          <div className="p-8 bg-white border border-slate-200 rounded-xl text-center text-slate-500">
            No monitoring data yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col items-center text-center">
              <span className="text-slate-500 font-medium mb-2">Check-Based Uptime</span>
              <span className="text-4xl font-bold text-slate-800">
                {summary.overallCheckBasedUptimePercentage?.toFixed(2) ?? '-'}%
              </span>
              <span className="text-xs text-slate-400 mt-2">Platform-wide average</span>
            </div>
            
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col items-center text-center">
              <span className="text-slate-500 font-medium mb-2">Average Response Latency</span>
              <span className="text-4xl font-bold text-slate-800">
                {summary.overallAverageResponseLatencyMs ? `${Math.round(summary.overallAverageResponseLatencyMs)} ms` : '-'}
              </span>
              <span className="text-xs text-slate-400 mt-2">Platform-wide average</span>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Total Checks</span>
                <span className="text-sm font-semibold text-slate-700">{summary.totalChecks.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Successful Checks</span>
                <span className="text-sm font-semibold text-emerald-600">{summary.successfulChecks.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Failed Checks</span>
                <span className="text-sm font-semibold text-red-600">{summary.failedChecks.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="pt-8 text-center">
        <Link to="/apis" className="text-indigo-600 font-medium hover:underline">
          Manage API Registry &rarr;
        </Link>
      </div>
    </div>
  );
};

const MetricCard = ({ title, value, icon }: { title: string; value: number | string; icon: React.ReactNode }) => (
  <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center space-x-4">
    <div className="p-3 bg-slate-50 rounded-lg">{icon}</div>
    <div>
      <div className="text-sm font-medium text-slate-500">{title}</div>
      <div className="text-2xl font-bold text-slate-800">{value}</div>
    </div>
  </div>
);
