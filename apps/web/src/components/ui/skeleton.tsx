import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'animate-shimmer rounded-xl bg-[linear-gradient(90deg,var(--color-muted)_0%,oklch(0.985_0.006_60)_50%,var(--color-muted)_100%)] bg-[length:200%_100%]',
        className,
      )}
      {...props}
    />
  );
}
