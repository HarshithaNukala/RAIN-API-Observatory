// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/server/drizzle/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
      // Use the Pino logger on the server. console.error/warn stay allowed for failures that
      // happen before a logger exists (bad config) and for dev-only browser diagnostics.
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    files: ['apps/server/**/*.ts', 'packages/**/*.ts', 'tests/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Runtime server code: test doubles (MockAgent, test-support helpers that divert sockets or
    // fake DNS) must never be reachable from the API or worker.
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/**/*.test.ts', 'apps/server/src/test-support/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'undici',
              importNames: ['MockAgent', 'MockClient', 'MockPool', 'mockErrors'],
              message: 'Mock dispatchers are for tests only.',
            },
          ],
          patterns: [
            {
              group: ['**/test-support/**'],
              message: 'test-support is for tests only; runtime code must not import it.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
