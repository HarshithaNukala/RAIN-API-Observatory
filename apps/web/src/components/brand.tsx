import { cn } from '@/lib/utils';

/** RAIN's mark: a terracotta cloud with concentric "signal" arcs. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 28" aria-hidden className={cn('h-7 w-10', className)}>
      <path
        d="M3 23 A7 7 0 0 1 12 14.5 A9 9 0 0 1 28 13 A7 7 0 0 1 37 23"
        fill="none"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary"
      />
      <path
        d="M13 23 A7 7 0 0 1 27 23"
        fill="none"
        strokeWidth="2.6"
        strokeLinecap="round"
        className="stroke-primary/70"
      />
      <path
        d="M17.5 23 A2.5 2.5 0 0 1 22.5 23"
        fill="none"
        strokeWidth="2.6"
        strokeLinecap="round"
        className="stroke-primary/45"
      />
      <path d="M3 23 H37" strokeWidth="2.8" strokeLinecap="round" className="stroke-primary" />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('group/brand flex items-center gap-2.5', className)}>
      <BrandMark className="transition-transform duration-500 ease-(--ease-out-soft) group-hover/brand:-translate-y-0.5" />
      <span className="flex flex-col leading-none">
        <span className="font-display text-lg font-bold tracking-wide text-foreground">RAIN</span>
        <span className="mt-0.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          API Observatory
        </span>
      </span>
    </span>
  );
}
