import { useId } from 'react';
import { cn } from '@/lib/utils';

const W = 120;
const H = 48;

/** Smooth path through the points (Catmull-Rom converted to cubic Béziers). */
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/**
 * A small decorative trend line with a soft area fill, drawn from real analytics buckets. Gaps
 * (null buckets) are skipped. Hidden from assistive technology: the card's number carries the
 * information, and the full series is on the Analytics page.
 */
export function Sparkline({
  values,
  color,
  className,
}: {
  values: Array<number | null>;
  color: string;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const indexed = values
    .map((v, i) => [i, v] as const)
    .filter((p): p is readonly [number, number] => p[1] !== null);
  if (indexed.length < 2) return null;

  const ys = indexed.map(([, v]) => v);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const last = Math.max(1, values.length - 1);
  const points = indexed.map(
    ([i, v]) => [(i / last) * W, H - 4 - ((v - min) / span) * (H - 12)] as [number, number],
  );
  const line = smoothPath(points);
  const area = `${line} L${points[points.length - 1]![0]},${H} L${points[0]![0]},${H} Z`;

  return (
    <div aria-hidden className={cn('pointer-events-none animate-reveal-x', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="size-full">
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.35" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id}-fill)`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          opacity={0.9}
        />
      </svg>
    </div>
  );
}
