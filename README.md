# RAIN API Observatory

API uptime and reliability monitoring, rebuilt in TypeScript. This repository replaces the legacy
Java application (kept read-only at `../RAIN API Observatory` as a reference for business-rule
migration).

**Current state: monitor management (configuration, credentials, web UI).** Health checks arrive
with the monitoring engine in a later phase.

## Stack

| Area     | Choice                                                                               |
| -------- | ------------------------------------------------------------------------------------ |
| Runtime  | Node.js 26 (`.nvmrc`), npm workspaces                                                |
| Web      | React 19, Vite, React Router, TanStack Query, Tailwind CSS 4, shadcn/ui, Supabase JS |
| API      | Express 5, Zod, jose (Supabase JWT verification), Helmet, express-rate-limit, Pino   |
| Database | Supabase Postgres, Drizzle ORM, drizzle-kit                                          |
| Tests    | Vitest, Supertest, Testcontainers                                                    |

## Layout

```
apps/
  server/          Express API (src/api.ts) and background worker (src/worker.ts)
    drizzle/       Generated SQL migrations
  web/             React single-page app
packages/
  shared/          Zod schemas + inferred types shared by web and server (API contracts)
tests/
  integration/     Database integration tests (disposable Postgres only)
  support/         Integration-test safety guard
docs/              Setup and testing guides
```

## Getting started

Prerequisites: Node.js 26 and npm 11. Docker is only needed for `npm run test:integration`.

```bash
npm install
cp .env.example .env    # then fill it in — see docs/supabase-setup.md
# ENCRYPTION_KEY is required; generate one and paste it into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm run db:migrate
npm run dev
```

- Web app: <http://localhost:5173> (proxies `/api`, `/healthz`, `/readyz` to the API)
- API: <http://localhost:3000>

Without a filled-in `.env`, the API and worker exit with a list of the missing variables, and the
web app shows a configuration page instead of the login screen.

## Commands

Run from the repository root.

| Command                    | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `npm install`              | Install all workspaces from the lockfile                             |
| `npm run dev`              | Shared package watch + API (tsx watch) + web (Vite)                  |
| `npm run dev:worker`       | Background worker in watch mode                                      |
| `npm run typecheck`        | `tsc --noEmit` in every workspace and the tests                      |
| `npm run lint`             | ESLint over the whole repository                                     |
| `npm run format`           | Prettier write (`format:check` to verify only)                       |
| `npm run test`             | Unit tests (no network, no database)                                 |
| `npm run test:integration` | Database tests against a disposable Postgres (Docker or guarded URL) |
| `npm run build`            | Production build of shared, server and web                           |
| `npm run db:generate`      | Generate a migration from `apps/server/src/db/schema.ts`             |
| `npm run db:migrate`       | Apply migrations to `DATABASE_URL`                                   |

Production start after `npm run build`: `npm run start -w @rain/server` (API) and
`npm run start:worker -w @rain/server` (worker).

## API

All responses are JSON. Success bodies under `/api` are `{ "data": ... }`; every error is
`{ "error": { "code", "message", "requestId", "details?" } }` (see `packages/shared/src/errors.ts`).
Every response carries an `X-Request-Id` header.

| Endpoint            | Auth   | Purpose                                                                                           |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `GET /healthz`      | none   | Process liveness                                                                                  |
| `GET /readyz`       | none   | Database reachable and configuration loaded; `503` when not ready                                 |
| `GET /api/v1/me`    | Bearer | The signed-in user and their profile (created on first call)                                      |
| `/api/v1/monitors…` | Bearer | Monitor CRUD, headers, pause/resume: see [docs/monitor-management.md](docs/monitor-management.md) |

`/api` routes return `401` for a missing, malformed, invalid or expired token (`TOKEN_EXPIRED`).
Requests are rate-limited per client IP (120/min) and bodies are capped at 256 kB.

## Security notes

- The browser only ever receives `VITE_*` variables: the Supabase URL and publishable key. The
  web app refuses to start with a secret/service-role key there.
- The API verifies Supabase access tokens locally with `jose`: JWKS for asymmetric keys, and the
  optional legacy HS256 secret for older projects. Anon and service-role tokens are rejected.
- Pino redacts `Authorization`, cookies and secret-looking fields from logs.
- `profiles`, `monitors` and `monitor_headers` have Row Level Security enabled with no policies,
  so only the API can access them.
- Monitor header values and request bodies are encrypted at rest with AES-256-GCM using
  `ENCRYPTION_KEY`. Header values are write-only: no API response returns them.

## Encryption keys

`ENCRYPTION_KEY` is a base64-encoded random 32-byte key; the API refuses to start without a valid
one. Back it up — encrypted values cannot be recovered without it.

To rotate: move the current key into `ENCRYPTION_PREVIOUS_KEYS` as `<version>:<key>`, put a new key
in `ENCRYPTION_KEY`, and increase `ENCRYPTION_KEY_VERSION`. New writes use the new key, and a
request body sealed with an older key is re-encrypted with the current key the next time its
monitor is edited. Header values move to the new key when they are next replaced. Keep a retired
key configured until no stored value uses its version
(`select distinct request_body_key_version from monitors` and
`select distinct encryption_key_version from monitor_headers`); removing it earlier makes those
values unreadable.

- Integration tests refuse to run against anything but a local or disposable `*_test` database,
  and never against the legacy `rain_db`.

## More

- [Supabase setup](docs/supabase-setup.md)
- [Testing](docs/testing.md)
- [Monitor management](docs/monitor-management.md)
- [Monitor network security](docs/security/monitor-network-security.md)
