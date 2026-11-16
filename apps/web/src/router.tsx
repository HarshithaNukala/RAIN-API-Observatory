import { createBrowserRouter } from 'react-router';
import { GuestOnly, RequireAuth } from './auth/route-guards';
import { AppShell } from './components/app-shell';
import { ForgotPasswordPage } from './pages/forgot-password-page';
import { LoginPage } from './pages/login-page';
import { NotFoundPage } from './pages/not-found-page';
import { OverviewPage } from './pages/overview-page';
import { RegisterPage } from './pages/register-page';
import { ResetPasswordPage } from './pages/reset-password-page';
import { RouteErrorPage } from './pages/route-error-page';

export const router = createBrowserRouter([
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
      {
        element: <RequireAuth />,
        children: [
          { element: <AppShell />, children: [{ index: true, element: <OverviewPage /> }] },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
