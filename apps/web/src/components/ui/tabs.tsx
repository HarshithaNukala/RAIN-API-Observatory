import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        // Scrolls sideways on narrow screens instead of wrapping or overflowing the page.
        'flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative -mb-px shrink-0 cursor-pointer rounded-t-lg px-3.5 py-2.5 text-sm font-semibold text-muted-foreground transition-colors duration-200 hover:bg-accent/60 hover:text-foreground focus-visible:ring-offset-0',
        // Active underline grows in from the centre.
        'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:origin-center after:scale-x-0 after:rounded-full after:bg-primary after:transition-transform after:duration-300 after:ease-(--ease-out-soft)',
        'data-[state=active]:text-primary data-[state=active]:after:scale-x-100',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('animate-fade-up pt-6 data-[state=inactive]:animate-none', className)}
      {...props}
    />
  );
}
