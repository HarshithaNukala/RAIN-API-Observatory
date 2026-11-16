import { defineConfig } from 'vitest/config';

// Unit tests: fast, no network, no database. Integration tests live in tests/integration
// and run with `npm run test:integration` (see vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}', 'tests/support/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
