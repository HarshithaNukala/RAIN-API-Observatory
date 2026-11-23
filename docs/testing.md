# Testing

## Unit tests — `npm run test`

Fast, no network, no database. They cover the shared Zod contracts, server and web environment
validation, JWT verification (valid, expired, wrong issuer/audience, tampered, unsigned,
anon/service-role tokens, legacy HS256, JWKS outage), the Express app (health endpoints, 401s,
standard error bodies, body limits, request IDs, rate limiting, CORS, security headers), log
redaction, the browser API client, and the integration-test database safety guard.

JWT tests use keys generated in memory by `apps/server/src/test-support/tokens.ts`. They prove the
verification logic, **not** that a real Supabase project issues compatible tokens. That needs the
manual check in [supabase-setup.md](./supabase-setup.md#6-check-it-works).

## Integration tests — `npm run test:integration`

These run the API against a real Postgres to test the profile upsert and the migration. They drop
and recreate schemas, so they only ever run against a disposable database:

1. **Default:** Testcontainers starts `postgres:17-alpine` in Docker and throws it away
   afterwards. Requires Docker (Docker Desktop on Windows/macOS).
2. **Without Docker:** set `TEST_DATABASE_URL` to a local Postgres database.

Before connecting, `tests/support/database-safety.ts` refuses any URL that:

- is not `postgres://` / `postgresql://`,
- equals `DATABASE_URL`,
- names `rain_db` (the legacy Java app's database) or `postgres` (Supabase's main database),
- does not end in `_test`,
- is not on `localhost`/`127.0.0.1`/`::1` (or the Testcontainers host).

Supabase's `auth.users` is stubbed in the test database with only the columns the foreign key
needs.

## UI tests (part of `npm run test`)

Files ending in `.test.tsx` under `apps/web` opt into a jsdom browser environment with
`// @vitest-environment jsdom`. They render the real route table and components through React
Testing Library and `user-event`, signed in with a test session, against
`apps/web/src/test-support/fake-monitor-api.ts`: an in-memory stand-in for the monitor API that
validates with the same shared schemas and follows the same origin and header rules as the
server.

These tests prove UI behaviour: forms, validation, credential handling, dialogs, navigation and
cache refreshes. They do **not** prove the backend. That is the job of the server's unit tests
(`monitor-service.test.ts` with an in-memory repository) and the database integration suite.

## UI harness (manual, development only)

`npx vite` in `apps/web`, then open `/harness.html?path=/app/monitors`. It renders the signed-in
screens against the same fake API, with a banner on every screen. It is not included in
`npm run build`.
