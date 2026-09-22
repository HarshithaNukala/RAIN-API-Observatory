
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useApi, useDeleteApi, usePauseApi, useResumeApi, useManualCheckApi } from '../services/apiRegistryHooks'
import { ArrowLeft, Play, Pause, Trash2, Settings, Activity, RefreshCw } from 'lucide-react'
import { ApiMetrics } from '../components/ApiMetrics'

export const ApiDetailsPage = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  
  const { data: api, isLoading, isError } = useApi(id)
  const deleteApi = useDeleteApi()
  const pauseApi = usePauseApi()
  const resumeApi = useResumeApi()
  const manualCheck = useManualCheckApi()

  if (isLoading) return <div className="p-8 text-center text-slate-500">Loading API details...</div>
  if (isError || !api) return <div className="p-8 text-center text-red-500">Failed to load API details</div>

  const handleDelete = () => {
    if (window.confirm(`Delete ${api.name}? This will remove its registry configuration.`)) {
      deleteApi.mutate(api.id!, {
        onSuccess: () => navigate('/apis')
      })
    }
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link to="/apis" className="inline-flex items-center text-sm text-indigo-600 hover:underline mb-6">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Registry
      </Link>
      
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight flex items-center">
            {api.name}
            <span className={`ml-4 text-xs px-2 py-1 rounded-full font-medium flex items-center ${
              api.currentStatus === 'PAUSED' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'
            }`}>
              {api.currentStatus === 'PAUSED' ? <Pause className="w-3 h-3 mr-1" /> : <Activity className="w-3 h-3 mr-1" />}
              {api.currentStatus}
            </span>
          </h1>
          <p className="text-slate-500 mt-2 font-mono text-sm">{api.method} {api.url}</p>
        </div>
        
        <div className="flex space-x-3">
          {api.enabled && (
            <button
              onClick={() => manualCheck.mutate(api.id!)}
              disabled={manualCheck.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${manualCheck.isPending ? 'animate-spin' : ''}`} />
              Check Now
            </button>
          )}
          {api.enabled ? (
            <button onClick={() => pauseApi.mutate(api.id!)} className="flex items-center px-4 py-2 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 transition border border-amber-200">
              <Pause className="w-4 h-4 mr-2" /> Pause Monitoring
            </button>
          ) : (
            <button onClick={() => resumeApi.mutate(api.id!)} className="flex items-center px-4 py-2 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 transition border border-emerald-200">
              <Play className="w-4 h-4 mr-2" /> Resume Monitoring
            </button>
          )}
          <button className="flex items-center px-4 py-2 bg-white text-slate-700 rounded-lg hover:bg-slate-50 transition border border-slate-200">
            <Settings className="w-4 h-4 mr-2" /> Edit
          </button>
          <button onClick={handleDelete} className="flex items-center px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition border border-red-200">
            <Trash2 className="w-4 h-4 mr-2" /> Delete
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Configuration</h3>
            <div className="grid grid-cols-2 gap-y-4 text-sm">
              <div><span className="block text-slate-500">Expected Status</span><span className="font-medium text-slate-800">{api.expectedStatusCode}</span></div>
              <div><span className="block text-slate-500">Timeout</span><span className="font-medium text-slate-800">{api.timeoutMs} ms</span></div>
              <div><span className="block text-slate-500">Latency Threshold</span><span className="font-medium text-slate-800">{api.latencyThresholdMs} ms</span></div>
              <div><span className="block text-slate-500">Monitoring Frequency</span><span className="font-medium text-slate-800">Every {api.checkIntervalSeconds} seconds</span></div>
              <div className="col-span-2"><span className="block text-slate-500">Description</span><span className="text-slate-800">{api.description || 'No description provided.'}</span></div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Configured Headers</h3>
            {(!api.headers || api.headers.length === 0) ? (
              <p className="text-sm text-slate-500">No headers configured.</p>
            ) : (
              <ul className="space-y-2">
                {api.headers.map((h, i) => (
                  <li key={i} className="flex justify-between items-center p-3 bg-slate-50 rounded-lg border border-slate-100 text-sm">
                    <span className="font-medium text-slate-700">{h.headerName}</span>
                    <span className="text-indigo-600 bg-indigo-50 px-2 py-1 rounded text-xs font-semibold">Configured</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-slate-400">Note: Actual secret values are never displayed.</p>
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Request Body</h3>
            <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700/50">
              <p className="text-sm text-slate-200 font-mono whitespace-pre-wrap">{api.requestBody || 'None'}</p>
            </div>
          </div>
        </div>

        <div className="col-span-1 space-y-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <ApiMetrics apiId={api.id!} />
          </div>
          
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 text-sm">
            <h3 className="font-semibold text-slate-800 mb-3">Metadata</h3>
            <div className="space-y-2 text-slate-600">
              <p><span className="text-slate-400">Created:</span> {api.createdAt ? new Date(api.createdAt).toLocaleString() : 'N/A'}</p>
              <p><span className="text-slate-400">Updated:</span> {api.updatedAt ? new Date(api.updatedAt).toLocaleString() : 'N/A'}</p>
              <p><span className="text-slate-400">ID:</span> {api.id}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
