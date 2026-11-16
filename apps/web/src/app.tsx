import type { SupabaseClient } from '@supabase/supabase-js';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './auth/auth-provider';
import { createQueryClient } from './lib/query-client';
import { router } from './router';

export function App({ supabase }: { supabase: SupabaseClient }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider supabase={supabase}>
        <RouterProvider router={router} />
      </AuthProvider>
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
