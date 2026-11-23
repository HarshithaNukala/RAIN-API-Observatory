import { useEffect } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { usePublicStatusPage } from './api';
import { StatusPageView } from './status-view';

/** `/status/:slug`: the public page. No sign-in, no app chrome, nothing private. */
export function PublicStatusPage() {
  const slug = useParams().slug ?? '';
  const query = usePublicStatusPage(slug);

  useEffect(() => {
    document.title = query.data ? `${query.data.title} · Status` : 'Status';
  }, [query.data]);

  if (query.isPending) {
    return (
      <main className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-12" aria-busy>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16" />
        <Skeleton className="h-48" />
      </main>
    );
  }
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <main className="mx-auto grid w-full max-w-xl gap-4 px-4 py-24 text-center">
        <h1 className="text-2xl font-bold">
          {notFound ? 'Status page not found' : "Couldn't load this status page"}
        </h1>
        <p className="text-muted-foreground">
          {notFound
            ? 'This page does not exist or is not public. Check the address.'
            : 'Please try again in a moment.'}
        </p>
        {!notFound && (
          <div>
            <Button
              variant="outline"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              Try again
            </Button>
          </div>
        )}
      </main>
    );
  }
  return (
    <main>
      <StatusPageView page={query.data} />
    </main>
  );
}
