import type { AnalyticsBucket, AnalyticsRange } from '@rain/shared';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { bucketLabel, bucketTick, NO_DATA } from './format';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** One value per bucket; null = no measurement (drawn as a gap, never as zero). */
  values: Array<number | null>;
}

const HEIGHT = 200;
/** Bars grow from their own baseline. */
const GROW_STYLE = { transformBox: 'fill-box', transformOrigin: 'bottom' } as const;
const MARGIN = { top: 10, right: 12, bottom: 26, left: 56 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Smallest 1/2/5 × 10ⁿ whole-number step that covers `max` in at most five intervals. */
function integerStep(max: number): number {
  for (let exp = 1; ; exp *= 10) {
    for (const f of [1, 2, 5]) {
      if (Math.ceil(max / (f * exp)) <= 5) return f * exp;
    }
  }
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  // A first guess for environments without layout (tests). The container has inline-size
  // containment, so the SVG never widens it: no feedback loop between measuring and drawing.
  const [width, setWidth] = useState(480);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure synchronously before paint; the observer then tracks later resizes.
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Top-rounded bar path (4px data-end radius), anchored square to the baseline. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function TimeSeriesChart({
  title,
  description,
  buckets,
  range,
  series,
  kind,
  format,
  yMax,
  emptyMessage,
  footer,
  integer = false,
}: {
  title: string;
  description: ReactNode;
  buckets: AnalyticsBucket[];
  range: AnalyticsRange;
  series: ChartSeries[];
  kind: 'line' | 'stacked' | 'grouped';
  format: (value: number) => string;
  /** Fixed top of the scale (e.g. 100 for percentages). */
  yMax?: number;
  emptyMessage: string;
  footer?: ReactNode;
  /** Values are counts: whole-number axis ticks. */
  integer?: boolean;
}) {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const n = buckets.length;
  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotW / Math.max(1, n);
  const xCenter = (i: number) => MARGIN.left + band * (i + 0.5);

  const hasData = series.some((s) =>
    s.values.some((v) => v !== null && (kind === 'line' || v > 0)),
  );
  const dataMax =
    kind === 'stacked'
      ? Math.max(
          0,
          ...buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)),
        )
      : Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  // Counts get whole-number ticks on a 1/2/5 × 10ⁿ step with at most five intervals (50 → 0, 10,
  // …, 50; 1 → 0, 1); other scales get nice quarters.
  const step = integer ? integerStep(Math.max(dataMax, 1)) : 0;
  const intervals = integer ? Math.max(1, Math.ceil(dataMax / step)) : 4;
  const top = yMax ?? (integer ? step * intervals : niceMax(dataMax));
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
  const ticks = integer
    ? Array.from({ length: intervals + 1 }, (_, k) => k * step)
    : [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));

  const bars = () => {
    const barW = Math.max(2, Math.min(24, band * (kind === 'grouped' ? 0.36 : 0.6)));
    return buckets.map((_, i) => {
      if (kind === 'stacked') {
        let base = 0;
        const parts = series
          .map((s, si) => ({ s, si, v: s.values[i] ?? 0 }))
          .filter((p) => p.v > 0);
        return parts.map(({ s, v }, pi) => {
          const y0 = y(base);
          base += v;
          const y1 = y(base);
          // 2px surface gap between stacked segments.
          const gap = pi > 0 ? 2 : 0;
          const h = Math.max(0, y0 - y1 - gap);
          return (
            <path
              key={`${s.key}-${i}`}
              d={barPath(xCenter(i) - barW / 2, y1, barW, h, pi === parts.length - 1)}
              fill={s.color}
              opacity={active === null || active === i ? 1 : 0.55}
              className="animate-grow-y"
              style={GROW_STYLE}
            />
          );
        });
      }
      return series.map((s, si) => {
        const v = s.values[i] ?? 0;
        if (v <= 0) return null;
        const x = xCenter(i) - barW - 1 + si * (barW + 2);
        return (
          <path
            key={`${s.key}-${i}`}
            d={barPath(x, y(v), barW, y(0) - y(v), true)}
            fill={s.color}
            opacity={active === null || active === i ? 1 : 0.55}
            className="animate-grow-y"
            style={GROW_STYLE}
          />
        );
      });
    });
  };

  const lines = () =>
    series.map((s) => {
      // Split at nulls: a missing bucket is a gap in the line, not a dip to zero.
      const segments: Array<Array<[number, number]>> = [];
      let current: Array<[number, number]> = [];
      s.values.forEach((v, i) => {
        if (v === null) {
          if (current.length) segments.push(current);
          current = [];
        } else current.push([xCenter(i), y(v)]);
      });
      if (current.length) segments.push(current);
      return (
        <g key={s.key}>
          {segments.map((seg, k) =>
            seg.length === 1 ? (
              <circle key={k} cx={seg[0]![0]} cy={seg[0]![1]} r={4} fill={s.color} />
            ) : (
              <polyline
                key={k}
                points={seg.map(([px, py]) => `${px},${py}`).join(' ')}
                pathLength={1}
                strokeDasharray={1}
                className="animate-draw"
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ),
          )}
          {active !== null && s.values[active] !== null && (
            <circle
              cx={xCenter(active)}
              cy={y(s.values[active]!)}
              r={4}
              fill={s.color}
              stroke="var(--color-card)"
              strokeWidth={2}
            />
          )}
        </g>
      );
    });

  const tooltipLeft =
    active === null ? 0 : Math.min(Math.max(xCenter(active) - 90, 0), width - 180);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle id={titleId} className="text-base">
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {series.length >= 2 && (
          <ul
            className="flex flex-wrap gap-4 text-xs font-semibold text-muted-foreground"
            aria-label={`${title} legend`}
          >
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2.5 rounded-sm"
                  style={{ background: s.color }}
                  aria-hidden
                />
                {s.label}
              </li>
            ))}
          </ul>
        )}
        <div ref={ref} className="relative w-full min-w-0 overflow-hidden [contain:inline-size]">
          {!hasData ? (
            <div
              className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground"
              style={{ height: HEIGHT }}
            >
              {emptyMessage}
            </div>
          ) : (
            <>
              <svg
                role="img"
                aria-labelledby={titleId}
                width={width}
                height={HEIGHT}
                className="block overflow-visible"
                onMouseLeave={() => setActive(null)}
              >
                {ticks.map((t) => (
                  <g key={t}>
                    <line
                      x1={MARGIN.left}
                      x2={MARGIN.left + plotW}
                      y1={y(t)}
                      y2={y(t)}
                      stroke="var(--color-border)"
                      strokeWidth={1}
                      strokeDasharray={t === 0 ? undefined : '2 4'}
                    />
                    <text
                      x={MARGIN.left - 8}
                      y={y(t)}
                      textAnchor="end"
                      dominantBaseline="middle"
                      className="fill-muted-foreground text-[10px] tabular-nums"
                    >
                      {format(t)}
                    </text>
                  </g>
                ))}
                {buckets.map((b, i) =>
                  i % labelEvery === 0 ? (
                    <text
                      key={b.start}
                      x={xCenter(i)}
                      y={HEIGHT - 8}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[10px]"
                    >
                      {bucketTick(b.start, range)}
                    </text>
                  ) : null,
                )}
                {active !== null && (
                  <line
                    x1={xCenter(active)}
                    x2={xCenter(active)}
                    y1={MARGIN.top}
                    y2={MARGIN.top + plotH}
                    stroke="var(--color-muted-foreground)"
                    strokeWidth={1}
                    opacity={0.5}
                  />
                )}
                {kind === 'line' ? lines() : bars()}
                {/* Hit targets: a full-height band per bucket, larger than any mark. */}
                {buckets.map((b, i) => (
                  <rect
                    key={`hit-${b.start}`}
                    data-testid="chart-hit"
                    x={MARGIN.left + band * i}
                    y={MARGIN.top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setActive(i)}
                    // Touch screens have no hover: a tap shows that period's values.
                    onPointerDown={() => setActive(i)}
                  />
                ))}
              </svg>
              {active !== null && buckets[active] && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute top-0 z-10 w-44 animate-fade-in rounded-xl border border-border bg-card/95 px-3 py-2.5 text-xs shadow-(--shadow-pop) backdrop-blur"
                  style={{ left: tooltipLeft }}
                >
                  <p className="mb-1.5 font-bold text-foreground">
                    {bucketLabel(buckets[active].start, buckets[active].end)}
                  </p>
                  {series.map((s) => (
                    <p
                      key={s.key}
                      className="flex items-center justify-between gap-2 text-muted-foreground"
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block size-2 rounded-sm"
                          style={{ background: s.color }}
                          aria-hidden
                        />
                        {s.label}
                      </span>
                      <span className="font-bold text-foreground tabular-nums">
                        {s.values[active] === null ? NO_DATA : format(s.values[active]!)}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        {footer}
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Show data table
          </summary>
          <div className="mt-2 max-h-64 overflow-auto">
            <table className="w-full text-xs" aria-label={`${title} data`}>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Period</th>
                  {series.map((s) => (
                    <th key={s.key} className="py-1 pr-3 font-medium">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {buckets.map((b, i) => (
                  <tr key={b.start} className="border-t border-border">
                    <td className="py-1 pr-3 whitespace-nowrap">{bucketLabel(b.start, b.end)}</td>
                    {series.map((s) => (
                      <td key={s.key} className="py-1 pr-3 tabular-nums">
                        {s.values[i] === null ? NO_DATA : format(s.values[i]!)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
