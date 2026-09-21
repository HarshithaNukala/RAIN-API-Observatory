import { useQuery } from '@tanstack/react-query'

interface HealthResponse {
  status: string
  service: string
  timestamp: string
}

const fetchHealth = async (): Promise<HealthResponse> => {
  const response = await fetch('/api/health')
  if (!response.ok) {
    throw new Error('Network response was not ok')
  }
  return response.json()
}

export const useHealth = () => {
  return useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: 1,
    refetchInterval: 5000 // Poll every 5s for demo purposes
  })
}
