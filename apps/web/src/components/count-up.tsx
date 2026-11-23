import { useEffect, useRef, useState } from 'react';

// Tests assert exact values, so numbers never animate there.
const ANIMATIONS_ENABLED = import.meta.env.MODE !== 'test';
const DURATION_MS = 900;

/** Only plain figures animate: "98.25%", "691 ms", "1.24 s", "1,200", "21". */
const NUMBER = /^([\d,]*\.?\d+)(%| ms| s)?$/;

function prefersReducedMotion() {
  return (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The figure's numeric value and a formatter that reproduces its shape, or null. */
function parse(value: string) {
  if (!ANIMATIONS_ENABLED || prefersReducedMotion()) return null;
  const match = NUMBER.exec(value);
  if (!match) return null;
  const digits = match[1]!;
  const suffix = match[2] ?? '';
  const decimals = digits.split('.')[1]?.length ?? 0;
  const grouped = digits.includes(',');
  return {
    target: Number(digits.replace(/,/g, '')),
    format: (n: number) =>
      (grouped
        ? n.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
        : n.toFixed(decimals)) + suffix,
  };
}

/**
 * Shows a formatted figure, counting up to it when it first appears or changes. Always ends on
 * the exact `value` string; anything that isn't a plain figure is shown as-is.
 */
export function CountUp({ value }: { value: string }) {
  const parsed = parse(value);
  const [display, setDisplay] = useState(() => (parsed ? parsed.format(0) : value));
  // The number currently on screen, so a new value (or an effect re-run) continues from it.
  const shown = useRef(0);

  useEffect(() => {
    const p = parse(value);
    if (!p) return;
    const start = shown.current;
    const began = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - began) / DURATION_MS);
      if (t < 1) {
        shown.current = start + (p.target - start) * (1 - (1 - t) ** 3);
        setDisplay(p.format(shown.current));
        frame = requestAnimationFrame(tick);
      } else {
        shown.current = p.target;
        setDisplay(value);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{parsed ? display : value}</>;
}
