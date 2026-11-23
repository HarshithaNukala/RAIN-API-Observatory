import { defineConfig } from 'vitest/config';

// Integration tests run against a disposable Postgres (Testcontainers, or a guarded
// TEST_DATABASE_URL). See tests/integration/global-setup.ts.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
