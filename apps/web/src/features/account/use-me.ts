import { MeSchema } from '@rain/shared';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/auth/auth-context';

export const meQueryKey = ['me'] as const;

export function useMe() {
  const { api } = useAuth();
  return useQuery({ queryKey: meQueryKey, queryFn: () => api.get('/api/v1/me', MeSchema) });
}
