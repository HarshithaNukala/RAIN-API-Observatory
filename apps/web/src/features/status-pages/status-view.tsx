import type { OverallStatus, PublicService, PublicStatusPage } from '@rain/shared';
import { AlertTriangle, CheckCircle2, CircleHelp, PauseCircle, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/utils';
import { formatDateTime, formatRelative } from '@/features/monitors/format';

/**
 * The public status page body, shared by the public route and the owner's preview. Everything is
 * rendered as text through React (escaped): titles and descriptions are plain text, never HTML.
 */

const OVERALL: Record<OverallStatus, { label: string; tone: string; icon: ReactNode }> = {
  HEALTHY: {
    label: 'All systems operational',
    tone: 'border-status-healthy/40 bg-status-healthy/10 text-status-healthy-fg shadow-[0_0_48px_-16px_var(--color-status-healthy)]',
    icon: <CheckCircle2 className="size-7 text-status-healthy-fg" aria-hidden />,
  },
  DEGRADED: {
    label: 'Degraded performance',
    tone: 'border-status-degraded/40 bg-status-degraded/10 text-status-degraded-fg shadow-[0_0_48px_-16px_var(--color-status-degraded)]',
    icon: <AlertTriangle className="size-7 text-status-degraded-fg" aria-hidden />,
  },
  DOWN: {
    label: 'Service disruption',
    tone: 'border-status-down/50 bg-status-down/10 text-status-down-fg shadow-[0_0_48px_-16px_var(--color-status-down)]',
    icon: <XCircle className="size-7 text-status-down-fg" aria-hidden />,
  },
  UNKNOWN: {
    label: 'Status not yet available',
    tone: 'border-border bg-muted/40 text-muted-foreground',
    icon: <CircleHelp className="size-7 text-muted-foreground" aria-hidden />,
  },
};

const SERVICE = {
  HEALTHY: { label: 'Operational', tone: 'success' },
  DEGRADED: { label: 'Degraded', tone: 'warning' },
  DOWN: { label: 'Down', tone: 'danger' },
  UNKNOWN: { label: 'No data yet', tone: 'neutral' },
  PAUSED: { label: 'Paused', tone: 'neutral' },
} as const;

const INCIDENT_STATUS = {
  INVESTIGATING: { label: 'Investigating', tone: 'danger' },
  IDENTIFIED: { label: 'Identified', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
} as const;

function formatPercent(value: number | null): string {
  if (value === null) return 'No data';
  // Rounded down so any failure never displays as 100%.
  const floored = Math.floor(value * 100) / 100;
  return `${floored === 100 ? '100' : floored.toFixed(2)}%`;
}

function dayTone(value: number | null): string {
  if (value === null) return 'bg-muted';
  if (value >= 99.9) return 'bg-status-healthy';
  if (value >= 95) return 'bg-status-degraded';
  return 'bg-status-down';
}

function AvailabilityBars({ service }: { service: PublicService }) {
  return (
    <div className="grid gap-1">
      <ol
        className="flex h-7 items-end gap-[2px]"
        aria-label={`${service.name}: daily availability`}
      >
        {service.days.map((d) => {
          const label = `${d.date}: ${d.availabilityPercent === null ? 'no data' : formatPercent(d.availabilityPercent)}`;
          return (
            <li
              key={d.date}
              title={label}
              aria-label={label}
              className={cn(
                'h-full min-w-[3px] flex-1 rounded-[2px]',
                dayTone(d.availabilityPercent),
              )}
            />
          );
        })}
      </ol>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{service.days.length} days ago</span>
        <span>{formatPercent(service.availabilityPercent)} available</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function ServiceRow({ service }: { service: PublicService }) {
  const s = SERVICE[service.status];
  return (
    <li
      className="grid gap-3 border-t border-border px-4 py-4 first:border-t-0 sm:px-6"
      data-testid="public-service"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold break-words">{service.name}</span>
        <span className="flex items-center gap-2">
          {service.status === 'PAUSED' && (
            <PauseCircle className="size-4 text-muted-foreground" aria-hidden />
          )}
          <Badge tone={s.tone}>{s.label}</Badge>
        </span>
      </div>
      <AvailabilityBars service={service} />
      <p className="text-xs text-muted-foreground">
        {service.status === 'PAUSED' ? (
          'Monitoring is paused; this service is not included in the overall status.'
        ) : service.lastCheckedAt ? (
          <>
            Last checked{' '}
            <time dateTime={service.lastCheckedAt} title={formatDateTime(service.lastCheckedAt)}>
              {formatRelative(service.lastCheckedAt)}
            </time>
          </>
        ) : (
          'Not checked yet.'
        )}
      </p>
    </li>
  );
}

export function StatusPageView({ page, banner }: { page: PublicStatusPage; banner?: ReactNode }) {
  const overall = OVERALL[page.overallStatus];
  const active = page.incidents.filter((i) => i.status !== 'RESOLVED');
  const past = page.incidents.filter((i) => i.status === 'RESOLVED');

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-8 sm:py-12">
      {banner}
      <header className="grid gap-2">
        <p className="text-[11px] font-bold tracking-[0.16em] text-primary uppercase">
          Service status
        </p>
        <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">
          {page.title}
        </h1>
        {page.description && (
          <p className="whitespace-pre-line break-words text-muted-foreground">
            {page.description}
          </p>
        )}
      </header>

      <section
        aria-label="Overall status"
        className={cn('flex items-center gap-4 rounded-2xl border p-5 sm:p-6', overall.tone)}
      >
        {overall.icon}
        <p className="font-display text-lg font-semibold text-foreground sm:text-2xl">
          {overall.label}
        </p>
      </section>

      <section aria-labelledby="services-heading" className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="services-heading" className="text-lg font-bold">
            Services
          </h2>
          <span className="text-xs text-muted-foreground">
            Check-based availability, last {page.historyDays} days
          </span>
        </div>
        {page.services.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
            No services are listed on this page yet.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-card shadow-(--shadow-card)">
            {page.services.map((s) => (
              <ServiceRow key={s.key} service={s} />
            ))}
          </ul>
        )}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-status-healthy" aria-hidden /> ≥
            99.9%
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-status-degraded" aria-hidden />{' '}
            95–99.9%
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-status-down" aria-hidden /> &lt;
            95%
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-muted" aria-hidden /> No data (not
            monitored)
          </span>
        </p>
      </section>

      <section aria-labelledby="incidents-heading" className="grid gap-3">
        <h2 id="incidents-heading" className="text-lg font-bold">
          Incidents
        </h2>
        {page.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No incidents in the last {page.historyDays} days.
          </p>
        ) : (
          <ol className="grid gap-3" aria-label="Incident history">
            {[...active, ...past].map((i) => (
              <li
                key={i.key}
                className="rounded-xl border border-border bg-card p-4 shadow-(--shadow-card) sm:p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold break-words">{i.title}</span>
                  <span className="flex gap-2">
                    <Badge tone="neutral">
                      {i.severity.charAt(0) + i.severity.slice(1).toLowerCase()}
                    </Badge>
                    <Badge tone={INCIDENT_STATUS[i.status].tone}>
                      {INCIDENT_STATUS[i.status].label}
                    </Badge>
                  </span>
                </div>
                <p className="mt-2 text-sm">{i.summary}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Started <time dateTime={i.startedAt}>{formatDateTime(i.startedAt)}</time>
                  {i.resolvedAt && (
                    <>
                      {' · '}Resolved{' '}
                      <time dateTime={i.resolvedAt}>{formatDateTime(i.resolvedAt)}</time>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="border-t border-border pt-4 text-xs text-muted-foreground">
        Last updated <time dateTime={page.generatedAt}>{formatDateTime(page.generatedAt)}</time> ·
        Powered by RAIN API Observatory
      </footer>
    </div>
  );
}
