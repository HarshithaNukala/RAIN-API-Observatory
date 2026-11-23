import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold cursor-pointer select-none',
    'transition-[color,background-color,border-color,box-shadow,transform] duration-200 ease-(--ease-out-soft)',
    'hover:-translate-y-px active:translate-y-0 active:scale-[0.98]',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-200',
    // Trailing arrows nudge forward on hover.
    '[&:hover_svg.lucide-arrow-right]:translate-x-0.5',
  ],
  {
    variants: {
      variant: {
        default:
          'btn-shine bg-linear-to-b from-primary to-primary-strong text-primary-foreground shadow-[0_1px_0_0_oklch(1_0_0/0.2)_inset,0_8px_20px_-10px_var(--color-primary)] hover:shadow-[0_1px_0_0_oklch(1_0_0/0.25)_inset,0_12px_26px_-10px_var(--color-primary)]',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:border-border-strong hover:bg-card',
        outline:
          'border border-border bg-card text-foreground shadow-[0_1px_2px_0_oklch(0.45_0.05_40/0.06)] hover:border-primary/40 hover:text-primary hover:shadow-[0_8px_18px_-12px_oklch(0.45_0.1_40/0.45)]',
        ghost: 'text-foreground hover:bg-accent hover:text-primary',
        destructive:
          'btn-shine bg-destructive text-destructive-foreground shadow-[0_8px_20px_-10px_var(--color-destructive)] hover:bg-destructive/90',
        link: 'h-auto px-0 text-primary underline-offset-4 hover:translate-y-0 hover:underline',
      },
      size: {
        default: 'h-10 px-4',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 px-6',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
