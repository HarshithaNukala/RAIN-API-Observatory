import { Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { GuestOnly, RequireAuth } from './auth/route-guards';
import { AppShell } from './components/app-shell';
import {
  EditMonitorPage,
  MonitorDetailPage,
  NewMonitorPage,
} from './features/monitors/monitor-pages';
import { MonitorsPage } from './features/monitors/monitors-page';
import { ForgotPasswordPage } from './pages/forgot-password-page';
import { LoginPage } from './pages/login-page';
import { NotFoundPage } from './pages/not-found-page';
import { OverviewPage } from './pages/overview-page';
import { RegisterPage } from './pages/register-page';
import { ResetPasswordPage } from './pages/reset-password-page';
import { RouteErrorPage } from './pages/route-error-page';

/** The whole route table; exported so tests can mount it in a memory router. */
export const routes: RouteObject[] = [
  {
    errorElement: <RouteErrorPage />,
    children: [
      {
        element: <GuestOnly />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/register', element: <RegisterPage /> },
          { path: '/forgot-password', element: <ForgotPasswordPage /> },
        ],
      },
      // Reachable signed in or out: the recovery link itself creates the session.
      { path: '/reset-password', element: <ResetPasswordPage /> },
      // Sign-in, email confirmation and password reset all land on "/".
      { path: '/', element: <Navigate to="/app" replace /> },
      {
        element: <RequireAuth />,
        children: [
          {
            path: '/app',
            element: <AppShell />,
            children: [
              { index: true, element: <OverviewPage /> },
              { path: 'monitors', element: <MonitorsPage /> },
              { path: 'monitors/new', element: <NewMonitorPage /> },
              { path: 'monitors/:monitorId', element: <MonitorDetailPage /> },
              { path: 'monitors/:monitorId/edit', element: <EditMonitorPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
