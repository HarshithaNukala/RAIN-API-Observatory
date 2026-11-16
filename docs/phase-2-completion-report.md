# RAIN API Observatory — Phase 2 completion report

Phase 2 (project foundation and authentication) — 16 November 2026.

Most of the code was written in an earlier Antigravity IDE session that stopped at its usage
limit. This session checked that work, fixed what failed, added what was missing, ran every check
that can run on this machine, and made the first commit. Every result below is from an actual run.

## Verdict

| Check                      | Result                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `npm run typecheck`        | **Pass** (after 1 fix)                                                          |
| `npm run lint`             | **Pass**, 0 errors, 0 warnings (ESLint config was missing — added)              |
| `npm run format:check`     | **Pass** (23 files reformatted with Prettier)                                   |
| `npm run test`             | **Pass** — 87 tests in 9 files                                                  |
| `npm run build`            | **Pass** — one warning: web bundle 746 kB (217 kB gzip) > 500 kB                |
| `npm run test:integration` | **Not run — Docker is not installed.** Setup failed safely with a clear message |
| Supabase auth end to end   | **Not verified** — no Supabase project credentials on this machine              |

## 1. Repository structure

```
rain-api-observatory/
├── .github/workflows/ci.yml       CI: typecheck, lint, format, unit tests, build; integration job
├── apps/
│   ├── server/                    Express API + worker (@rain/server)
│   │   ├── drizzle/               0000_create_profiles.sql + meta
│   │   └── src/
│   │       ├── api.ts             API entry (config → logger → DB → JWKS → app → graceful shutdown)
│   │       ├── worker.ts          Worker entry (config, startup/shutdown logs, SIGTERM/SIGINT)
│   │       ├── app.ts             Express app: pino-http, helmet, CORS, body limit, rate limit
│   │       ├── config.ts          Zod-validated env for API and worker
│   │       ├── logger.ts          Pino with secret redaction
│   │       ├── errors.ts          AppError + helpers
│   │       ├── auth/              verify-token.ts (jose: JWKS + legacy HS256), require-auth.ts
│   │       ├── db/                client.ts, schema.ts (profiles), profiles.ts (upsert store)
│   │       ├── http/              error-handler.ts, request-id.ts
│   │       ├── routes/            health.ts (/healthz, /readyz), me.ts (/api/v1/me)
│   │       └── test-support/      In-memory JWT signer, supertest helper
│   └── web/                       React SPA (@rain/web)
│       └── src/
│           ├── auth/              AuthProvider, context, route guards, form schemas
│           ├── components/        App shell, auth layout, brand, form field, ui/ (shadcn)
│           ├── features/account/  useMe (TanStack Query)
│           ├── lib/               api-client (authed fetch), supabase, env, query-client
│           └── pages/             login, register, forgot/reset password, overview, 404, errors
├── packages/shared/               Zod contracts (@rain/shared): errors, profile, health, envelope
├── tests/
│   ├── integration/               global-setup (Testcontainers / guarded URL), profiles.test.ts
│   └── support/                   database-safety.ts (+ tests)
├── docs/                          supabase-setup.md, testing.md, screenshots/, this report
├── eslint.config.js, tsconfig.base.json, vitest.config.ts, vitest.integration.config.ts
└── .env.example, .nvmrc (26), .npmrc (save-exact, engine-strict), .gitignore, README.md
```

## 2. Files created or changed in this session

| File                                | Change                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| `apps/web/src/lib/api-client.ts`    | Fixed TS2339 (Zod generic envelope type) — the only typecheck error |
| `eslint.config.js`                  | **New.** `npm run lint` failed outright: no ESLint config existed   |
| `README.md`                         | **New.** Stack, layout, commands, API, security notes               |
| `docs/supabase-setup.md`            | **New.** Project, keys, JWT signing modes, redirect URLs, migration |
| `docs/testing.md`                   | **New.** Unit vs integration tests, database safety rules           |
| `.github/workflows/ci.yml`          | **New.** The `.github/workflows` folder was empty                   |
| `docs/screenshots/*.jpg`            | **New.** 5 screenshots                                              |
| `docs/phase-2-completion-report.md` | **New.** This report                                                |
| 23 source/config files              | Prettier formatting only                                            |

All other files (about 95) came from the earlier session and were reviewed, not rewritten.

## 3. Technologies and dependency versions

All versions are pinned exactly (`save-exact=true`); `package-lock.json` is committed.

| Area    | Packages                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime | Node.js v26.13.0, npm 11.20.0 (machine); `engines.node >= 26`                                                                                                                                                                                  |
| Shared  | zod 4.6.7                                                                                                                                                                                                                                      |
| Server  | express 5.3.0, helmet 8.3.0, cors 2.8.6, express-rate-limit 8.7.4, jose 6.2.17, pino 10.4.0, pino-http 11.0.0, drizzle-orm 0.45.4, postgres 3.4.9, drizzle-kit 0.31.11, tsx 4.23.15                                                            |
| Web     | react / react-dom 19.3.1, react-router 8.5.1, @tanstack/react-query 5.107.1, @supabase/supabase-js 2.119.0, tailwindcss 4.3.5, vite 8.3.8, @vitejs/plugin-react 6.3.0, shadcn/ui (Radix label/slot, cva, tailwind-merge), lucide-react, sonner |
| Tooling | typescript 6.0.3, eslint 10.15.0, typescript-eslint 8.72.2, prettier 3.10.1, vitest 5.1.0, supertest 7.3.2, testcontainers / @testcontainers/postgresql 12.2.1                                                                                 |

Strict TypeScript everywhere: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noUnusedLocals/Parameters`, `verbatimModuleSyntax`.

## 4. Environment setup

```bash
npm install
cp .env.example .env     # one .env at the repo root serves every workspace
```

Server variables: `DATABASE_URL`, `SUPABASE_URL`, optional `SUPABASE_JWT_SECRET` (legacy HS256
only), `SUPABASE_JWT_AUDIENCE` (default `authenticated`), `PORT` (3000), `LOG_LEVEL`,
`CORS_ORIGINS`, `TRUST_PROXY`. Browser variables: `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`.

Missing or invalid variables stop the API and worker with a list of every problem, without
printing secret values. The web app shows a configuration page instead of the login screen, and
refuses a `sb_secret_…` / `service_role` key in `VITE_*`.

## 5. Supabase setup

Full steps are in `docs/supabase-setup.md`. In short: create a dev project → copy the URL, the
publishable key and the session-pooler `DATABASE_URL` into `.env` → leave `SUPABASE_JWT_SECRET`
empty for asymmetric signing keys (verified through JWKS), or set it for legacy HS256 projects → add
`http://localhost:5173/reset-password` and `http://localhost:5173/` to the Auth redirect URLs.

## 6. Database migration

```bash
npm run db:migrate     # applies apps/server/drizzle to DATABASE_URL
npm run db:generate    # after editing apps/server/src/db/schema.ts
```

`0000_create_profiles.sql` creates `public.profiles` (`id uuid PK → auth.users(id) ON DELETE
CASCADE`, `display_name text NULL`, `created_at` / `updated_at timestamptz NOT NULL DEFAULT now()`)
with Row Level Security enabled and no policies, so only the API can access it. The first
authenticated `GET /api/v1/me` upserts the row with `INSERT … ON CONFLICT DO NOTHING`, which is
safe under concurrent requests. No monitor, incident or notification tables were created.

**The migration has not been applied to a real database yet.** There was no Supabase project and
no Docker.

## 7. Commands executed

```
node -v / npm -v                       v26.13.0 / 11.20.0
npm run typecheck                      fail (1 error) → fixed → pass
npm run lint                           fail (no config) → config added → 3 no-console → rule tuned → pass
npx prettier --check / --write .       23 files reformatted → pass
npm run test                           pass (87/87)
npm run build                          pass (chunk-size warning)
npm run test:integration               fail at setup: no container runtime (Docker not installed)
node dist/api.js, node dist/worker.js  smoke test with placeholder config (below)
vite (apps/web) + in-app browser       screenshots (below)
```

## 8. TypeScript check

**Pass.** One error before the fix: `apps/web/src/lib/api-client.ts(72,24): TS2339 Property 'data'
does not exist`. TypeScript cannot resolve Zod's object output type while the schema is a generic
`T`, so the validated value is now typed as the shared `DataEnvelope<T>`. Covers shared, server,
web and `tests/`.

## 9. Lint

**Pass**, with 0 errors and 0 warnings. ESLint 10 needs a flat `eslint.config.js`, and there was
none, so `npm run lint` crashed. The new config uses `@eslint/js` + `typescript-eslint`
(recommended), `consistent-type-imports`, `eqeqeq` and `no-console`, plus
`react-hooks`/`react-refresh` for the web app and `eslint-config-prettier`. `console.error`/`warn`
are allowed for configuration failures that happen before the logger exists.

## 10. Unit tests

**87 passed, 0 failed, 9 files, about 3.5 s.**

- Shared Zod schemas: profile, `/me`, error body, health
- Server env validation: required vars, empty `.env` values, non-postgres URL, no secret echo,
  CORS origins, legacy secret length, https required in production
- JWT verification (jose): valid; expired → `TOKEN_EXPIRED`; wrong issuer; wrong audience; no
  `exp`; unknown key; tampered payload; `alg: none`; garbage; non-UUID `sub`; anon and
  service_role tokens rejected; HS256 accepted only with the configured legacy secret; JWKS outage
  → 503
- HTTP: `/healthz`, `/readyz` (200 and 503), missing/malformed/invalid/expired token → 401 with
  the standard error body, `/api/v1/me` success, 404, auth checked before route existence, bad JSON,
  413 body limit, request-ID echo and sanitising, rate limit, CORS allowlist, security headers,
  500s hide internal details
- Logger redaction (`Authorization`, cookies, nested secrets)
- Web: env parsing (rejects service-role keys), auth form schemas, API client (envelope parsing,
  error mapping, 401 → refresh → retry, network errors)
- Integration safety guard (refuses `rain_db`, `postgres`, non-`_test`, remote hosts, `DATABASE_URL`)

The JWT tests use keys generated in memory. They prove the verification logic, not compatibility
with a live Supabase project.

## 11. Integration tests

**Not run.** `tests/integration/profiles.test.ts` has 8 tests: RLS enabled, first-access creation,
idempotency, concurrent upsert, unknown user → 401, cascade delete, `/api/v1/me` against the real
database, `/readyz` with a real ping. Global setup fails with _"Integration tests need Docker (for
Testcontainers) or TEST_DATABASE_URL pointing at a local Postgres database whose name ends in
\_test"_, caused by _"Could not find a working container runtime strategy"_. The CI workflow runs
them on GitHub's Ubuntu runners, which have Docker, but CI hasn't run yet because the repo has no
remote.

## 12. Production build

**Pass.** `@rain/shared` and `@rain/server` compile with `tsc`. `@rain/web` built with Vite 8
in about 1 s: `index.html` 0.65 kB, CSS 21.2 kB (4.9 kB gzip), JS 745.9 kB (217.1 kB gzip). Vite
warns that the JS chunk is over 500 kB. There is no route-level code splitting yet.

### Runtime smoke test (built output, placeholder config, no real DB or Supabase)

| Request                                  | Result                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                           | 200 `{"status":"ok"}` + `X-Request-Id`                                                                         |
| `GET /readyz`                            | 503 `{"status":"not_ready","checks":{"database":"error","auth":"error"}}` (correct: neither exists)            |
| `GET /api/v1/me` (no token)              | 401 `UNAUTHENTICATED` "Missing bearer token" + `requestId`                                                     |
| `GET /api/v1/me` (bad token)             | 401 `UNAUTHENTICATED` "Invalid access token"                                                                   |
| Logs                                     | `authorization: "[REDACTED]"`; Helmet headers present                                                          |
| Worker / API with missing `DATABASE_URL` | Exit 1 with a readable list of problems                                                                        |
| SIGINT and SIGTERM (API and worker)      | "shutting down" → "stopped", exit 0 (handlers fired in-process; Windows can't send POSIX signals from a shell) |

## 13. Screenshots

Taken from the Vite dev server with **placeholder** Supabase values: enough to render, not to sign
in. Files are in `docs/screenshots/`.

- `login.jpg` — visiting `/` signed out redirects to `/login` (protected route works)
- `register.jpg`, `register-validation.jpg` — invalid email, short password and mismatched
  confirmation are caught on the client
- `forgot-password.jpg`
- `not-found.jpg` — 404 page

No screenshot of the signed-in shell or overview page exists, because that needs a real Supabase
session.

## 14. Known limitations

1. **Supabase auth is not runtime-verified.** Registration, login, session persistence, logout and
   password recovery are implemented but have not run against a real project.
2. **Integration tests have not run** (no Docker here). Install Docker Desktop, or provide a local
   Postgres `*_test` database through `TEST_DATABASE_URL`.
3. **The migration has not been applied** to any real database.
4. **CI has not run.** The repository has no GitHub remote yet.
5. The web bundle is 746 kB unsplit. Lazy-loading routes would remove the warning.
6. The Phase 0 audit and Phase 1 spec files were not on this machine, so this phase was checked
   against the Phase 2 brief and the legacy `ARCHITECTURE.md`.
7. Rate limiting is in-memory per process (fine for one API instance; Redis is out of scope).

## 15. Remaining tasks (to close Phase 2)

1. Create a Supabase dev project, fill in `.env`, run `npm run db:migrate`.
2. Register → confirm the email → sign in → check that `/api/v1/me` creates the profile; test
   logout and password recovery; take screenshots of the signed-in shell.
3. Install Docker Desktop and run `npm run test:integration`.
4. Push to GitHub and confirm both CI jobs pass.
5. Optional: lazy-load routes to clear the bundle-size warning.

The next phase (monitor management) was not started.
