import React from 'react';
import { useServiceIntelligence } from '../services/intelligenceHooks';

interface IntelligencePanelProps {
  serviceId: number;
}

export const IntelligencePanel: React.FC<IntelligencePanelProps> = ({ serviceId }) => {
  const { data, isLoading, error } = useServiceIntelligence(serviceId);

  if (isLoading) {
    return <div className="animate-pulse bg-gray-100 dark:bg-gray-800 h-32 rounded-lg"></div>;
  }

  if (error || !data) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-4 rounded-lg text-sm">
        Failed to load reliability intelligence.
      </div>
    );
  }

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  };

  const renderTrend = () => {
    switch (data.scoreTrend) {
      case 'IMPROVING':
        return <span className="text-green-600 font-medium text-lg ml-2">↑</span>;
      case 'DECLINING':
        return <span className="text-red-600 font-medium text-lg ml-2">↓</span>;
      case 'STABLE':
        return <span className="text-gray-500 font-medium text-lg ml-2">-</span>;
      default:
        return null;
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-gray-200 dark:border-gray-700 pb-6 md:pb-0">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Reliability Score</h3>
        <div className="flex items-center">
          <span className="text-5xl font-bold text-gray-900 dark:text-white">
            {data.reliabilityScore !== null ? data.reliabilityScore.toFixed(1) : '--'}
          </span>
          {renderTrend()}
        </div>
        <span className="text-xs text-gray-400 mt-1">Last 7 days</span>
      </div>

      <div className="flex flex-col justify-center px-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Top Error Types</h3>
        {data.topErrorTypes.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">No errors in this window</p>
        ) : (
          <div className="space-y-3">
            {data.topErrorTypes.slice(0, 3).map((error) => (
              <div key={error.errorType}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="font-medium text-gray-700 dark:text-gray-300 truncate w-32" title={error.errorType}>{error.errorType}</span>
                  <span className="text-gray-500">{error.percentage.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                  <div className="bg-red-500 h-1.5 rounded-full" style={{ width: `${error.percentage}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col justify-center border-t md:border-t-0 md:border-l border-gray-200 dark:border-gray-700 pt-6 md:pt-0 px-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3 flex items-center">
          <svg className="w-4 h-4 mr-1 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          Insights
        </h3>
        
        <div className="space-y-3 text-sm">
          {data.rootCauseHints.length > 0 ? (
            <ul className="space-y-2">
              {data.rootCauseHints.map((hint, idx) => (
                <li key={idx} className="flex items-start text-gray-600 dark:text-gray-300">
                  <span className="text-indigo-500 mr-2">•</span>
                  <span>{hint}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 italic">No significant insights derived.</p>
          )}

          <div className="pt-2 mt-2 border-t border-gray-100 dark:border-gray-700">
            <p className="flex justify-between">
              <span className="text-gray-500">Recovery Time:</span>
              <span className="font-medium text-gray-900 dark:text-white">
                {data.avgRecoveryTimeMs !== null ? formatDuration(data.avgRecoveryTimeMs) : '--'}
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
