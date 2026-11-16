import { Navigate, Outlet, useLocation } from 'react-router';
import { FullPageSpinner } from '@/components/ui/spinner';
import { useAuth } from './auth-context';

interface FromState {
  from?: string;
}

export function RequireAuth() {
  const { auth } = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') return <FullPageSpinner label="Restoring your session" />;
  if (auth.status === 'signed-out') {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from } satisfies FromState} />;
  }
  return <Outlet />;
}

/** Login/registration pages: signed-in users are sent back to where they were going. */
export function GuestOnly() {
  const { auth } = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') return <FullPageSpinner label="Restoring your session" />;
  if (auth.status === 'signed-in') {
    const from = (location.state as FromState | null)?.from;
    // Only same-app paths; never an absolute URL from history state.
    const target = from?.startsWith('/') && !from.startsWith('//') ? from : '/';
    return <Navigate to={target} replace />;
  }
  return <Outlet />;
}
