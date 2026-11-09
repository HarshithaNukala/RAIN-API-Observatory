import { useQuery } from '@tanstack/react-query';
import type { ServiceIntelligenceResponse } from '../types/intelligence';

export const useServiceIntelligence = (serviceId: number, window: string = '7d') => {
  return useQuery<ServiceIntelligenceResponse, Error>({
    queryKey: ['serviceIntelligence', serviceId, window],
    queryFn: async () => {
      const response = await fetch(`/api/services/${serviceId}/intelligence?window=${window}`);
      if (!response.ok) {
        throw new Error('Failed to fetch intelligence data');
      }
      return response.json();
    },
    refetchInterval: 30000,
  });
};
