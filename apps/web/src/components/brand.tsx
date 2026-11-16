import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-8', className)}>
      <rect width="32" height="32" rx="8" className="fill-primary/15" />
      <path
        d="M8 20a8 8 0 0 1 16 0"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-primary"
      />
      <path
        d="M12 20a4 4 0 0 1 8 0"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-primary/60"
      />
      <circle cx="16" cy="20" r="1.6" className="fill-foreground" />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <BrandMark />
      <span className="flex flex-col leading-none">
        <span className="text-sm font-semibold tracking-wide">RAIN</span>
        <span className="text-[11px] text-muted-foreground">API Observatory</span>
      </span>
    </span>
  );
}
