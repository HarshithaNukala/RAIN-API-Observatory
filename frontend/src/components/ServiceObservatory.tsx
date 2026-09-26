import React from 'react';
import { Link } from 'react-router-dom';
import type { ApiService } from '../services/apiRegistryHooks';
import { AlertCircle, Clock, CheckCircle, XCircle, HelpCircle, Activity, PauseCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ServiceObservatoryProps {
  apis: ApiService[];
}

export const ServiceObservatory: React.FC<ServiceObservatoryProps> = ({ apis }) => {
  if (apis.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
        <h3 className="text-lg font-medium text-slate-800 mb-2">No APIs Registered</h3>
        <p className="text-slate-500 mb-6">Add your first API to begin monitoring.</p>
        <Link
          to="/apis/new"
          className="inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700"
        >
          Add API
        </Link>
      </div>
    );
  }

  const getStatusIcon = (status: string | undefined) => {
    switch (status) {
      case 'HEALTHY': return <CheckCircle className="w-5 h-5 text-emerald-500" />;
      case 'DEGRADED': return <AlertCircle className="w-5 h-5 text-amber-500" />;
      case 'DOWN': return <XCircle className="w-5 h-5 text-red-500" />;
      case 'PAUSED': return <PauseCircle className="w-5 h-5 text-slate-400" />;
      case 'UNKNOWN':
      default: return <HelpCircle className="w-5 h-5 text-slate-400" />;
    }
  };

  const getStatusBadge = (status: string | undefined) => {
    switch (status) {
      case 'HEALTHY': return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">Healthy</span>;
      case 'DEGRADED': return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">Degraded</span>;
      case 'DOWN': return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Down</span>;
      case 'PAUSED': return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-800">Paused</span>;
      case 'UNKNOWN':
      default: return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">Unknown</span>;
    }
  };

  const getMonitoringStateBadge = (enabled: boolean | undefined) => {
    if (enabled) {
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">Enabled</span>;
    }
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-800">Paused</span>;
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Service</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Method</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Current Status</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Monitoring State</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Last Checked</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Incident</th>
              <th scope="col" className="relative px-6 py-3"><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-slate-200">
            {apis.map((api) => (
              <tr key={api.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      {getStatusIcon(api.currentStatus)}
                    </div>
                    <div className="ml-4">
                      <div className="text-sm font-medium text-slate-900">{api.name}</div>
                      <div className="text-sm text-slate-500 truncate max-w-[200px]" title={api.url}>{api.url}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className="text-sm font-mono text-slate-600 bg-slate-100 px-2 py-1 rounded">
                    {api.method}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {getStatusBadge(api.currentStatus)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {getMonitoringStateBadge(api.enabled)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                  {api.lastCheckedAt ? (
                    <div className="flex items-center space-x-1">
                      <Clock className="w-4 h-4" />
                      <span>{formatDistanceToNow(new Date(api.lastCheckedAt), { addSuffix: true })}</span>
                    </div>
                  ) : (
                    <span className="text-slate-400">Never</span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {api.hasActiveIncident ? (
                    <div className="flex items-center space-x-1 text-red-600">
                      <Activity className="w-4 h-4 animate-pulse" />
                      <span className="text-sm font-medium">Active</span>
                    </div>
                  ) : (
                    <span className="text-sm text-slate-400">-</span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <Link to={`/apis/${api.id}`} className="text-indigo-600 hover:text-indigo-900">
                    Details
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
