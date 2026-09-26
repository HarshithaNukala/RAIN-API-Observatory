import { useState, useMemo } from 'react';
import { useDashboardSummary } from '../services/metrics';
import { useApis } from '../services/apiRegistryHooks';
import { useRecentIncidents } from '../services/incidents';
import type { TimeWindow } from '../types/metrics';
import { Activity, CheckCircle, XCircle, AlertCircle, Clock, Server, AlertTriangle } from 'lucide-react';
import { ServiceObservatory } from '../components/ServiceObservatory';
import { IncidentFeed } from '../components/IncidentFeed';

export const DashboardPage = () => {
  const [window, setWindow] = useState<TimeWindow>('24h');
  
  const { data: summary, isLoading: isLoadingSummary, isError: isErrorSummary } = useDashboardSummary(window);
  const { data: apis, isLoading: isLoadingApis, isError: isErrorApis } = useApis();
  const { data: incidents, isLoading: isLoadingIncidents, isError: isErrorIncidents } = useRecentIncidents(50);

  // Derive explicit states based on Phase 6 spec (Applies only to global summary state)
  const summaryState = useMemo(() => {
    if (isLoadingSummary) return 'LOADING';
    if (isErrorSummary) return 'ERROR';
    if (!summary) return 'LOADING';
    if (summary.totalApis === 0) return 'NO_APIS';
    if (summary.totalChecks === 0) return 'NO_TELEMETRY';
    
    if (summary.downApis > 0 || summary.activeIncidents > 0) return 'ACTIVE_ISSUE';
    if (summary.degradedApis > 0) return 'DEGRADED';
    
    // All Healthy State logic: Must have observations and no unknown/down/degraded
    if (summary.healthyApis > 0 && summary.degradedApis === 0 && summary.downApis === 0 && summary.unknownApis === 0) {
      return 'HEALTHY';
    }
    
    // Mixed state (e.g. paused APIs, unknown APIs)
    return 'MIXED';
  }, [summary, isLoadingSummary, isErrorSummary]);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header and Global Banner */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Observatory</h1>
          <p className="text-slate-500 mt-1">Platform registry, telemetry, and active incidents.</p>
        </div>
        <div className="flex items-center space-x-4">
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
      </div>

      {/* State Banners */}
      {summaryState === 'ACTIVE_ISSUE' && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-r-lg flex items-start space-x-3">
          <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-red-800">Active Issues Detected</h3>
            <p className="text-sm text-red-700 mt-1">
              There are {summary?.activeIncidents} active incidents and {summary?.downApis} APIs currently down.
            </p>
          </div>
        </div>
      )}

      {summaryState === 'HEALTHY' && (
        <div className="bg-emerald-50 border-l-4 border-emerald-500 p-4 rounded-r-lg flex items-start space-x-3">
          <CheckCircle className="w-5 h-5 text-emerald-500 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-emerald-800">All Systems Healthy</h3>
            <p className="text-sm text-emerald-700 mt-1">
              All {summary?.healthyApis} monitored APIs are operating normally.
            </p>
          </div>
        </div>
      )}

      {summaryState === 'NO_TELEMETRY' && (
        <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-lg flex items-start space-x-3">
          <Activity className="w-5 h-5 text-blue-500 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-blue-800">Collecting Telemetry...</h3>
            <p className="text-sm text-blue-700 mt-1">
              Waiting for the first health checks to complete.
            </p>
          </div>
        </div>
      )}

      {/* Global Overview Section */}
      <section>
        <h2 className="text-lg font-semibold text-slate-700 mb-4">Global Overview</h2>
        
        {summaryState === 'ERROR' && (
          <div className="bg-red-50 p-4 rounded-lg text-red-600 font-medium text-center">
            Failed to load Global Overview.
          </div>
        )}
        {summaryState === 'LOADING' && (
          <div className="animate-pulse flex space-x-4 p-8 justify-center border rounded-xl">
            <div className="text-slate-400">Loading overview...</div>
          </div>
        )}
        {summaryState !== 'LOADING' && summaryState !== 'ERROR' && summary && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
              <MetricCard title="Total APIs" value={summary.totalApis} icon={<Server className="w-4 h-4 text-indigo-500" />} />
              <MetricCard title="Healthy" value={summary.healthyApis} icon={<CheckCircle className="w-4 h-4 text-emerald-500" />} />
              <MetricCard title="Degraded" value={summary.degradedApis} icon={<AlertCircle className="w-4 h-4 text-amber-500" />} />
              <MetricCard title="Down" value={summary.downApis} icon={<XCircle className="w-4 h-4 text-red-500" />} />
              <MetricCard title="Unknown" value={summary.unknownApis} icon={<AlertCircle className="w-4 h-4 text-slate-400" />} />
              <MetricCard title="Paused" value={summary.pausedApis} icon={<Clock className="w-4 h-4 text-slate-400" />} />
              <MetricCard 
                title="Active Incidents" 
                value={summary.activeIncidents} 
                icon={<Activity className={`w-4 h-4 ${summary.activeIncidents > 0 ? 'text-red-500 animate-pulse' : 'text-slate-400'}`} />} 
                highlight={summary.activeIncidents > 0}
              />
            </div>

            {summary.totalChecks > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center text-center">
                  <span className="text-slate-500 font-medium mb-1 text-sm">Check-Based Uptime</span>
                  <span className="text-3xl font-bold text-slate-800">
                    {summary.overallCheckBasedUptimePercentage?.toFixed(2) ?? '-'}%
                  </span>
                </div>
                <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center text-center">
                  <span className="text-slate-500 font-medium mb-1 text-sm">Avg Latency</span>
                  <span className="text-3xl font-bold text-slate-800">
                    {summary.overallAverageResponseLatencyMs ? `${Math.round(summary.overallAverageResponseLatencyMs)} ms` : '-'}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main column: Service Observatory */}
        <div className="lg:col-span-2 space-y-6">
          <section>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-slate-700">Service Observatory</h2>
            </div>
            
            {isErrorApis ? (
              <div className="bg-red-50 p-4 rounded-lg text-red-600 font-medium text-center">
                Failed to load Service Observatory.
              </div>
            ) : isLoadingApis ? (
              <div className="animate-pulse flex space-x-4 p-8 justify-center border rounded-xl">
                <div className="text-slate-400">Loading services...</div>
              </div>
            ) : (
              <ServiceObservatory apis={apis || []} />
            )}
          </section>
        </div>

        {/* Side column: Incident Feed */}
        <div className="space-y-6">
          <section>
            {isErrorIncidents ? (
              <div className="bg-red-50 p-4 rounded-lg text-red-600 font-medium text-center">
                Failed to load Recent Incidents.
              </div>
            ) : isLoadingIncidents ? (
              <div className="animate-pulse flex space-x-4 p-8 justify-center border rounded-xl">
                <div className="text-slate-400">Loading incidents...</div>
              </div>
            ) : (
              <IncidentFeed incidents={incidents || []} apis={apis || []} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

const MetricCard = ({ title, value, icon, highlight = false }: { title: string; value: number | string; icon: React.ReactNode; highlight?: boolean }) => (
  <div className={`bg-white p-4 rounded-xl border ${highlight ? 'border-red-300 ring-1 ring-red-100 bg-red-50' : 'border-slate-200'} shadow-sm flex flex-col justify-between`}>
    <div className="flex items-center space-x-2 text-sm font-medium text-slate-500 mb-2">
      {icon}
      <span>{title}</span>
    </div>
    <div className={`text-2xl font-bold ${highlight ? 'text-red-700' : 'text-slate-800'}`}>{value}</div>
  </div>
);
