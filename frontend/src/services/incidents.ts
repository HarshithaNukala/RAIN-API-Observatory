import { useQuery } from '@tanstack/react-query';
import type { IncidentDto } from '../types/incident';

export const useRecentIncidents = (limit = 50) => {
  return useQuery<IncidentDto[]>({
    queryKey: ['recentIncidents', limit],
    queryFn: async () => {
      const response = await fetch(`/api/incidents?limit=${limit}`);
      if (!response.ok) throw new Error('Failed to fetch incidents');
      return response.json();
    },
    refetchInterval: 30000, // Phase 6 requirement: 30s polling
  });
};

export const useRecentIncidentsForService = (apiServiceId: number, limit = 50) => {
  return useQuery<IncidentDto[]>({
    queryKey: ['recentIncidentsForService', apiServiceId, limit],
    queryFn: async () => {
      const response = await fetch(`/api/services/${apiServiceId}/incidents?limit=${limit}`);
      if (!response.ok) throw new Error('Failed to fetch incidents for service');
      return response.json();
    },
    refetchInterval: 30000,
  });
};
