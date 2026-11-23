import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * Soft layered "dune" waves in peach and terracotta. Purely decorative: hidden from assistive
 * technology and never intercepting clicks.
 */
export function Waves({ className, animated = true }: { className?: string; animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      aria-hidden
      viewBox="0 0 600 220"
      preserveAspectRatio="none"
      className={cn('pointer-events-none select-none', className)}
    >
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(0.78 0.11 42)" stopOpacity="0.55" />
          <stop offset="1" stopColor="oklch(0.9 0.05 50)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(0.7 0.14 38)" stopOpacity="0.45" />
          <stop offset="1" stopColor="oklch(0.88 0.06 45)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-c`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(0.62 0.16 36)" stopOpacity="0.35" />
          <stop offset="1" stopColor="oklch(0.86 0.07 45)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className={animated ? 'animate-float' : undefined}>
        <path
          d="M0 140 C80 90 140 60 220 95 S360 160 430 105 S540 40 600 70 V220 H0 Z"
          fill={`url(#${id}-a)`}
        />
      </g>
      <g
        className={animated ? 'animate-float' : undefined}
        style={animated ? { animationDelay: '-3s', animationDuration: '11s' } : undefined}
      >
        <path
          d="M0 170 C90 130 170 110 250 140 S400 190 470 140 S560 95 600 115 V220 H0 Z"
          fill={`url(#${id}-b)`}
        />
      </g>
      <g
        className={animated ? 'animate-float' : undefined}
        style={animated ? { animationDelay: '-6s', animationDuration: '13s' } : undefined}
      >
        <path
          d="M0 200 C110 170 200 165 290 185 S450 215 520 185 S580 160 600 168 V220 H0 Z"
          fill={`url(#${id}-c)`}
        />
      </g>
    </svg>
  );
}
