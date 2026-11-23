import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests: fast, no network, no database. Integration tests live in tests/integration
// and run with `npm run test:integration` (see vitest.integration.config.ts).
// UI tests opt into a browser-like DOM with a `// @vitest-environment jsdom` comment.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}', 'tests/support/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['apps/web/src/test-support/setup.ts'],
    restoreMocks: true,
  },
});
