import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from './api-client';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** The screen shows this mutation's errors itself (a form or dialog), so don't toast. */
      inlineErrors?: boolean;
    };
  }
}

const isClientError = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      // First loads render their own error state; only failed background refreshes toast.
      onError: (error, query) => {
        if (query.state.data !== undefined) toast.error(`Couldn't refresh data: ${error.message}`);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.inlineErrors) return;
        toast.error(error.message || 'Something went wrong');
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => !isClientError(error) && failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}
