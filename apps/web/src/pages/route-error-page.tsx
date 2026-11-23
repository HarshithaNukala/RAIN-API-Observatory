import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Brand } from '@/components/brand';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NotFoundPage } from './not-found-page';

/** Catches render errors anywhere in the route tree so one broken view never blanks the app. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  if (import.meta.env.DEV) console.error(error);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <Brand />
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error stopped this page from loading.
        </p>
      </div>
      {import.meta.env.DEV && error instanceof Error && (
        <Alert variant="error" className="max-w-md">
          <code className="break-all text-xs">{error.message}</code>
        </Alert>
      )}
      <Button onClick={() => window.location.assign('/')}>Reload RAIN</Button>
    </main>
  );
}
