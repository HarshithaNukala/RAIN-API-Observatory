
import { Link } from 'react-router-dom'
import { useApis, usePauseApi, useResumeApi, useDeleteApi } from '../services/apiRegistryHooks'
import { Play, Pause, Trash2, Edit, Plus } from 'lucide-react'

export const ApiRegistryPage = () => {
  const { data: apis, isLoading, isError } = useApis()
  const pauseApi = usePauseApi()
  const resumeApi = useResumeApi()
  const deleteApi = useDeleteApi()

  if (isLoading) return <div className="p-8 text-center text-slate-500">Loading APIs...</div>
  if (isError) return <div className="p-8 text-center text-red-500">Failed to load APIs</div>

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">API Registry</h1>
          <p className="text-slate-500 mt-1">Manage and configure your APIs for monitoring.</p>
        </div>
        <Link to="/apis/new" className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition">
          <Plus className="w-4 h-4 mr-2" /> Add API
        </Link>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm">
              <th className="p-4 font-medium">Name</th>
              <th className="p-4 font-medium">Endpoint</th>
              <th className="p-4 font-medium">Method</th>
              <th className="p-4 font-medium">Status</th>
              <th className="p-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {apis?.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-slate-400">No APIs registered yet.</td>
              </tr>
            ) : (
              apis?.map((api) => (
                <tr key={api.id} className="border-b border-slate-100 hover:bg-slate-50 transition">
                  <td className="p-4">
                    <Link to={`/apis/${api.id}`} className="font-semibold text-indigo-600 hover:underline">
                      {api.name}
                    </Link>
                  </td>
                  <td className="p-4 text-slate-600 text-sm font-mono truncate max-w-[300px]">
                    {api.url}
                  </td>
                  <td className="p-4">
                    <span className="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded-md font-medium">
                      {api.method}
                    </span>
                  </td>
                  <td className="p-4">
                    <span className={`flex items-center text-sm font-medium ${api.currentStatus === 'PAUSED' ? 'text-amber-600' : 'text-slate-600'}`}>
                      <span className={`w-2 h-2 rounded-full mr-2 ${api.currentStatus === 'PAUSED' ? 'bg-amber-500' : 'bg-slate-400'}`}></span>
                      {api.currentStatus}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end space-x-2">
                      {api.enabled ? (
                        <button onClick={() => api.id && pauseApi.mutate(api.id)} className="p-2 text-slate-400 hover:text-amber-600 transition" title="Pause Monitoring">
                          <Pause className="w-4 h-4" />
                        </button>
                      ) : (
                        <button onClick={() => api.id && resumeApi.mutate(api.id)} className="p-2 text-slate-400 hover:text-emerald-600 transition" title="Resume Monitoring">
                          <Play className="w-4 h-4" />
                        </button>
                      )}
                      <Link to={`/apis/${api.id}`} className="p-2 text-slate-400 hover:text-indigo-600 transition" title="View/Edit">
                        <Edit className="w-4 h-4" />
                      </Link>
                      <button onClick={() => {
                        if (window.confirm(`Delete ${api.name}? This will remove its registry configuration.`)) {
                          if(api.id) deleteApi.mutate(api.id)
                        }
                      }} className="p-2 text-slate-400 hover:text-red-600 transition" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
