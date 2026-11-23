import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { FIELD_CLASS } from './input';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        info: 'border-primary/25 bg-peach/60 text-primary',
        success: 'border-status-healthy/30 bg-status-healthy/12 text-status-healthy-fg',
        warning: 'border-status-degraded/40 bg-status-degraded/18 text-status-degraded-fg',
        danger: 'border-status-down/30 bg-status-down/10 text-status-down-fg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(FIELD_CLASS, 'min-h-28 py-2 font-mono', className)} {...props} />;
}

/** A styled native select: accessible, keyboard-friendly and works on every device. */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select
        className={cn(FIELD_CLASS, 'h-10 cursor-pointer appearance-none pr-9', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn(
          'w-full caption-bottom text-[13px] [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-accent/60',
          // Header row on a soft tinted band, as in the dashboard design.
          '[&_thead]:bg-muted/70',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-10 px-3 text-left align-middle text-[11px] font-bold tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td
      className={cn(
        'px-3 py-3.5 align-middle first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5',
        className,
      )}
      {...props}
    />
  );
}
