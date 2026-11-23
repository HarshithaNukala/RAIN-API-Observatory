// Shared Vitest setup. DOM additions only apply to tests that opt into the jsdom environment.
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

if (typeof window !== 'undefined') {
  afterEach(() => cleanup());

  // findBy*/waitFor default to 1 s, which full-page renders can exceed when the whole suite runs
  // in parallel on a busy machine. A longer ceiling only matters when a test would fail anyway.
  configure({ asyncUtilTimeout: 3000 });

  // jsdom lacks these browser APIs that Radix UI and sonner use.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver ??= ResizeObserverStub;
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  const proto = window.HTMLElement.prototype;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
}
