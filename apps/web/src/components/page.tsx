import { ChevronRight, RefreshCw, type LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';

export interface Crumb {
  label: string;
  /** Omit for the current page. */
  to?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        {items.map((item, i) => (
          <Fragment key={`${item.label}-${i}`}>
            {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
            <li className="min-w-0">
              {item.to ? (
                <Link to={item.to} className="hover:text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span aria-current="page" className="block max-w-64 truncate text-foreground">
                  {item.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <div className="grid gap-3">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10">
        <Icon className="size-5 text-primary" aria-hidden />
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A failed load with the API's message, its request ID for support, and a retry button. */
export function ErrorState({
  error,
  onRetry,
  retrying,
  title = "Couldn't load this data",
}: {
  error: Error;
  onRetry: () => void;
  retrying: boolean;
  title?: string;
}) {
  return (
    <Alert variant="error">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground">{error.message}</p>
          {error instanceof ApiError && error.requestId && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Request ID: {error.requestId}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          {retrying ? <Spinner label="Retrying" /> : <RefreshCw aria-hidden />}
          Retry
        </Button>
      </div>
    </Alert>
  );
}
