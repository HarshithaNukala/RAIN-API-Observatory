import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCreateApi, type ApiService } from '../services/apiRegistryHooks'

export const AddApiPage = () => {
  const navigate = useNavigate()
  const createApi = useCreateApi()
  
  const [formData, setFormData] = useState<ApiService>({
    name: '',
    url: '',
    method: 'GET',
    description: '',
    expectedStatusCode: 200,
    timeoutMs: 5000,
    latencyThresholdMs: 1000,
    checkIntervalSeconds: 60,
    headers: []
  })
  
  const [errorMsg, setErrorMsg] = useState('')

  const validate = () => {
    if (!formData.name.trim()) return "Name is required."
    if (!formData.url.trim() || !/^https?:\/\/.+/.test(formData.url)) return "Please enter a valid HTTP/HTTPS URL."
    if (formData.expectedStatusCode < 100 || formData.expectedStatusCode > 599) return "Expected status code must be between 100 and 599."
    if (formData.timeoutMs <= 0) return "Timeout must be greater than 0."
    if (formData.latencyThresholdMs < 0) return "Latency threshold must be non-negative."
    if (formData.checkIntervalSeconds <= 0) return "Check interval must be greater than 0."
    return null
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const err = validate()
    if (err) {
      setErrorMsg(err)
      return
    }
    createApi.mutate(formData, {
      onSuccess: () => navigate('/apis'),
      onError: (err: unknown) => setErrorMsg(err instanceof Error ? err.message : 'Failed to create API')
    })
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-slate-800 tracking-tight mb-8">Add New API</h1>
      
      {errorMsg && <div className="p-4 mb-6 bg-red-50 text-red-600 rounded-lg border border-red-100">{errorMsg}</div>}
      
      <form onSubmit={handleSubmit} className="bg-white p-8 rounded-xl shadow-sm border border-slate-200 space-y-6">
        <div className="grid grid-cols-2 gap-6">
          <div className="col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">API Name</label>
            <input type="text" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">Endpoint URL</label>
            <input type="text" placeholder="https://api.example.com/v1/health" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              value={formData.url} onChange={e => setFormData({...formData, url: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">HTTP Method</label>
            <select className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              value={formData.method} onChange={e => setFormData({...formData, method: e.target.value})}>
              <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Expected Status Code</label>
            <input type="number" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              value={formData.expectedStatusCode} onChange={e => setFormData({...formData, expectedStatusCode: parseInt(e.target.value)})} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Timeout (ms)</label>
            <input type="number" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              value={formData.timeoutMs} onChange={e => setFormData({...formData, timeoutMs: parseInt(e.target.value)})} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Latency Threshold (ms)</label>
            <input type="number" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              value={formData.latencyThresholdMs} onChange={e => setFormData({...formData, latencyThresholdMs: parseInt(e.target.value)})} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Monitoring Frequency (seconds)</label>
            <input type="number" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              value={formData.checkIntervalSeconds} onChange={e => setFormData({...formData, checkIntervalSeconds: parseInt(e.target.value)})} />
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">Description (optional)</label>
            <textarea className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500" rows={3}
              value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})}></textarea>
          </div>
        </div>

        <div className="flex justify-end space-x-4 pt-4 border-t border-slate-100">
          <button type="button" onClick={() => navigate('/apis')} className="px-6 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancel</button>
          <button type="submit" disabled={createApi.isPending} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50">
            {createApi.isPending ? 'Saving...' : 'Register API'}
          </button>
        </div>
      </form>
    </div>
  )
}
