import React from 'react';
import { Link } from 'react-router-dom';
import type { IncidentDto } from '../types/incident';
import type { ApiService } from '../services/apiRegistryHooks';
import { formatDistanceToNow, format } from 'date-fns';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';

interface IncidentFeedProps {
  incidents: IncidentDto[];
  apis: ApiService[];
}

export const IncidentFeed: React.FC<IncidentFeedProps> = ({ incidents, apis }) => {
  if (incidents.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-slate-800 mb-1">No Recent Incidents</h3>
        <p className="text-slate-500 text-sm">All systems are operating normally.</p>
      </div>
    );
  }

  const getApiName = (apiId: number) => {
    return apis.find(api => api.id === apiId)?.name || `Unknown API (ID: ${apiId})`;
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
        <h3 className="text-lg font-semibold text-slate-800">Recent Incidents</h3>
      </div>
      <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
        {incidents.map((incident) => {
          const isOpen = incident.status === 'OPEN';
          
          return (
            <div key={incident.id} className={`p-6 transition-colors hover:bg-slate-50 ${isOpen ? 'bg-red-50/30' : ''}`}>
              <div className="flex items-start justify-between">
                <div className="flex items-start space-x-4">
                  <div className={`mt-1 p-2 rounded-full ${isOpen ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-500'}`}>
                    {isOpen ? <AlertTriangle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
                  </div>
                  <div>
                    <div className="flex items-center space-x-3 mb-1">
                      <Link to={`/apis/${incident.apiServiceId}`} className="font-semibold text-slate-900 hover:text-indigo-600 transition">
                        {getApiName(incident.apiServiceId)}
                      </Link>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${isOpen ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-600'}`}>
                        {isOpen ? 'Active Incident' : 'Resolved'}
                      </span>
                    </div>
                    
                    {incident.latestErrorMessage && (
                      <p className="text-sm text-slate-700 mb-2 font-mono bg-slate-100 p-2 rounded max-w-2xl break-all">
                        {incident.latestErrorMessage}
                      </p>
                    )}
                    
                    <div className="flex items-center flex-wrap gap-4 text-xs text-slate-500">
                      <div className="flex items-center space-x-1">
                        <Clock className="w-4 h-4" />
                        <span title={format(new Date(incident.startedAt), 'PPpp')}>
                          Started: {formatDistanceToNow(new Date(incident.startedAt), { addSuffix: true })}
                        </span>
                      </div>
                      
                      {incident.resolvedAt && (
                        <div className="flex items-center space-x-1 text-slate-500">
                          <CheckCircle2 className="w-4 h-4" />
                          <span title={format(new Date(incident.resolvedAt), 'PPpp')}>
                            Resolved: {formatDistanceToNow(new Date(incident.resolvedAt), { addSuffix: true })}
                          </span>
                        </div>
                      )}
                      
                      <div className="bg-slate-100 px-2 py-1 rounded">
                        Failed Checks: <span className="font-semibold text-slate-700">{incident.failureCount}</span>
                      </div>
                      
                      {incident.latestErrorType && (
                        <div className="bg-slate-100 px-2 py-1 rounded">
                          Type: <span className="font-medium text-slate-700">{incident.latestErrorType}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
