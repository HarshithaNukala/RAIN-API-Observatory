import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface ApiHeader {
  headerName: string;
  headerValue?: string; // used for requests
  configured?: boolean; // used in responses
}

export interface ApiService {
  id?: number;
  name: string;
  url: string;
  method: string;
  description?: string;
  expectedStatusCode: number;
  timeoutMs: number;
  latencyThresholdMs: number;
  checkIntervalSeconds: number;
  enabled?: boolean;
  currentStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  headers?: ApiHeader[];
}

const API_BASE = '/api/services'

export const useApis = () => {
  return useQuery<ApiService[]>({
    queryKey: ['apis'],
    queryFn: async () => {
      const res = await fetch(API_BASE)
      if (!res.ok) throw new Error('Failed to fetch APIs')
      return res.json()
    }
  })
}

export const useApi = (id: string | undefined) => {
  return useQuery<ApiService>({
    queryKey: ['apis', id],
    queryFn: async () => {
      if (!id) throw new Error('ID is required')
      const res = await fetch(`${API_BASE}/${id}`)
      if (!res.ok) throw new Error('Failed to fetch API')
      return res.json()
    },
    enabled: !!id
  })
}

export const useCreateApi = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (newApi: ApiService) => {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newApi)
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(JSON.stringify(error))
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
    }
  })
}

export const useUpdateApi = (id: string | undefined) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (api: ApiService) => {
      if (!id) throw new Error('ID is required')
      const res = await fetch(`${API_BASE}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(api)
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(JSON.stringify(error))
      }
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['apis', id] })
    }
  })
}

export const useDeleteApi = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete API')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
    }
  })
}

export const usePauseApi = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE}/${id}/pause`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to pause API')
      return res.json()
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['apis', String(id)] })
    }
  })
}

export const useResumeApi = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`${API_BASE}/${id}/resume`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to resume API')
      return res.json()
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['apis', String(id)] })
    }
  })
}
