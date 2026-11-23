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
      <ol className="flex flex-wrap items-center gap-1.5 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {items.map((item, i) => (
          <Fragment key={`${item.label}-${i}`}>
            {i > 0 && <ChevronRight className="size-3.5 opacity-60" aria-hidden />}
            <li className="min-w-0">
              {item.to ? (
                <Link to={item.to} className="transition-colors hover:text-primary">
                  {item.label}
                </Link>
              ) : (
                <span aria-current="page" className="block max-w-64 truncate text-foreground/80">
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

/** Terracotta emphasis inside a page title, e.g. "API Health <Accent>at a Glance</Accent>". */
export function Accent({ children }: { children: ReactNode }) {
  return (
    <span className="bg-linear-to-r from-primary to-[oklch(0.62_0.17_45)] bg-clip-text text-transparent">
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  eyebrow,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  /** A small uppercase label above the title (used when there are no breadcrumbs). */
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="grid animate-fade-up gap-3">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      {!breadcrumbs && eyebrow && (
        <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          {eyebrow}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight break-words sm:text-4xl">{title}</h1>
          {description && (
            <div className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              {description}
            </div>
          )}
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
    <div className="flex animate-fade-up flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="relative flex size-16 items-center justify-center">
        <span
          aria-hidden
          className="absolute inset-0 animate-soft-ping rounded-full bg-primary/15"
          style={{ animationDuration: '3s' }}
        />
        <span className="relative flex size-16 items-center justify-center rounded-full bg-peach">
          <Icon className="size-7 text-primary" aria-hidden />
        </span>
      </span>
      <h2 className="mt-2 text-lg font-bold">{title}</h2>
      {children && (
        <div className="max-w-md text-sm leading-relaxed text-muted-foreground">{children}</div>
      )}
      {action && <div className="mt-3">{action}</div>}
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
    <Alert variant="error" className="animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{title}</p>
          <p className="text-muted-foreground">{error.message}</p>
          {error instanceof ApiError && error.requestId && (
            <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
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
