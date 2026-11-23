import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Shared look for text inputs, selects and textareas. */
export const FIELD_CLASS =
  'w-full rounded-xl border border-input bg-card px-3 text-sm shadow-[0_1px_2px_0_oklch(0.45_0.05_40/0.05)] transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-primary/60 focus-visible:ring-primary/25 focus-visible:ring-4 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input type={type} className={cn(FIELD_CLASS, 'flex h-10 py-2', className)} {...props} />;
}
