# RAIN API Observatory — Phase 2 closure audit

Audit date: 16 November 2026 · Commit audited: `1093b96` · Auditor: Claude (Claude Code session)

This audit only checks Phase 2. No Monitor CRUD and no Phase 3 work was started. No
implementation code was changed. Git history was not changed. The legacy Java repository was not
modified (`git status` clean). No secrets were created, read or recorded.

Statuses: **PASS** = evidence supports completion · **BLOCKED** = an external prerequisite
prevents verification · **FAIL** = implementation does not meet requirements · **NOT TESTED** = no
verification performed.

---

## 1. Commit audit

| Item                           | Value                                                               |
| ------------------------------ | ------------------------------------------------------------------- |
| Branch                         | `main`                                                              |
| HEAD                           | `1093b9670b230981810597debe887903c2d47021` (root commit, no parent) |
| Commits on any branch          | 1                                                                   |
| Remote                         | none configured                                                     |
| Working tree before this audit | clean (`git status --short` empty)                                  |
| Uncommitted after this audit   | this file, `docs/phase-2-closure-audit.md` (untracked)              |
| Commit contents                | 110 files, all `A` (added), 13,908 insertions                       |

### Origin of the 110 files

Everything was untracked before `1093b96`, so git can't tell the two sessions apart. The split
below comes from file modification times. The earlier Antigravity session wrote files between
15:40 and 16:41; this implementation session touched files between 19:56 and 20:01.

**Written by the earlier session, unchanged here: 76 files.** These include all of
`packages/shared/src/*`, the server's `config.ts`, `logger.ts`, `errors.ts`, `env-file.ts`,
`worker.ts`, `routes/*`, `auth/require-auth.ts`, `auth/verify-token.test.ts`, `db/client.ts`,
`db/schema.ts`, `http/error-handler.ts`, `test-support/*`, `drizzle/*`, most web pages and UI
components, `tests/support/*`, all tsconfig/vitest/prettier/editor configs, `.env.example`,
`.gitignore`, `.nvmrc`, `.npmrc`, `package.json` files and `package-lock.json`.

**Created in this session: 11 files.**
`eslint.config.js`, `.github/workflows/ci.yml`, `README.md`, `docs/supabase-setup.md`,
`docs/testing.md`, `docs/phase-2-completion-report.md`, `docs/screenshots/{login,register,
register-validation,forgot-password,not-found}.jpg`.

**Changed in this session: 22 files.**

- Real code change, 1 file: `apps/web/src/lib/api-client.ts` (typecheck fix for TS2339; also
  reformatted).
- Prettier formatting only, 21 files: `apps/server/src/{api.ts, app.test.ts,
auth/verify-token.ts, config.test.ts, db/profiles.ts, http/request-id.ts}`,
  `apps/web/index.html`, `apps/web/src/{auth/auth-context.ts, auth/auth-provider.tsx,
auth/schemas.ts, auth/schemas.test.ts, components/app-shell.tsx, components/ui/alert.tsx,
lib/api-client.test.ts, main.tsx, pages/login-page.tsx, pages/overview-page.tsx,
pages/register-page.tsx, router.tsx}`, `tests/integration/{global-setup.ts,
profiles.test.ts}`, `tests/tsconfig.json`.

Commit identity: `Prajit <account email>`. No git identity was configured on the machine, so it
was passed for this one commit with `git -c`; global config was not changed.

---

## 2. Reproducibility

### 2a. First attempt, in the working checkout: **FAILED (environmental, caused by the auditor)**

```
npm ci  => exit 127
npm error code EPERM  syscall unlink
  path ...\node_modules\lightningcss-win32-x64-msvc\lightningcss.win32-x64-msvc.node
```

**Cause:** four Node processes left running by the previous implementation session's smoke tests
held the native `lightningcss` module open. They are PIDs 17508 (`dist/worker.js`), 10156
(`dist/api.js`), 8540 and 18788 (Vite on :5173). Git Bash's `kill` and the task stop did not end
them on Windows. The auditor's attempt to stop them was refused by the session's permission
policy, so they are still running.

**Effect:** `npm ci` had already deleted part of `node_modules` before it failed, so every later
command in that checkout fails (exit 1). **The working checkout's `node_modules` stays broken until
the owner stops those processes and re-runs `npm ci`** (see blocker B0). The lockfile was not
changed (`git diff --quiet package-lock.json` → clean).

### 2b. Clean clone of `1093b96`: **all commands PASS**

The commit was cloned into a fresh scratch directory, so nothing in it depends on
untracked files.

| Command                | Exit | Time | Result                                                              |
| ---------------------- | ---- | ---- | ------------------------------------------------------------------- |
| `npm ci`               | 0    | 28 s | `added 550 packages, and audited 560 packages`                      |
| `npm run typecheck`    | 0    | 12 s | shared, server, web, tests: no errors                               |
| `npm run lint`         | 0    | 6 s  | `eslint .` — no output (0 problems)                                 |
| `npm run format:check` | 0    | 2 s  | `All matched files use Prettier code style!`                        |
| `npm run test`         | 0    | 4 s  | `Test Files 9 passed (9)` · `Tests 87 passed (87)`                  |
| `npm run build`        | 0    | 5 s  | identical output hashes to the original build (`index-Bf81sk2I.js`) |
| `npm run db:generate`  | 0    | —    | `1 tables · profiles 4 columns 0 indexes 1 fks · No schema changes` |

The clone's working tree stayed clean after every command, so nothing writes tracked files.

### 2c. Observations from `npm ci` (not defects)

- **npm 11 install-script gating.** Install scripts for esbuild (3 versions), protobufjs and
  ssh2 were skipped (`not yet covered by allowScripts`). They aren't needed: `tsx` 4.23.15
  and an esbuild TypeScript transform both ran in the clone, and drizzle-kit works.
  `protobufjs` and `ssh2` are only used by Testcontainers. Re-check this once Docker is available.
- **`npm audit`: 17 moderate, 0 high/critical, all in dev-only tooling.** They come from
  drizzle-kit (old `esbuild` via `@esbuild-kit/*`), testcontainers (`archiver` → `glob`) and
  typescript-eslint (`minimatch`). npm's suggested fixes are downgrades to older major versions,
  so none were applied. **`npm audit --omit=dev` → `found 0 vulnerabilities`** (runtime
  dependencies are clean).

---

## 3. Supabase readiness (code review plus placeholder-mode runtime)

**No Supabase project exists for this repository, and no credentials were available.**
Everything in this section was checked by reading the code, by unit tests using locally generated
keys, or by running against a deliberately non-existent placeholder host. **No real Supabase
authentication has been performed.**

| Area                                | Finding                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend client (`lib/supabase.ts`) | `createClient(url, publishableKey)` with `flowType: 'pkce'`, `persistSession`, `autoRefreshToken`, `detectSessionInUrl`. Env parsed by Zod; refuses `sb_secret_…` / `service_role` keys (unit tested).                                  |
| Registration                        | `auth.signUp` with `emailRedirectTo: origin + '/'`. Shows a neutral "Check your inbox" message (doesn't reveal whether the email exists) when no session is returned (email confirmation on); otherwise the session listener redirects. |
| Login                               | `auth.signInWithPassword`; errors shown in an alert; `GuestOnly` redirects after `SIGNED_IN`, only to same-app paths (open-redirect guarded).                                                                                           |
| Logout                              | `auth.signOut()`, falling back to `signOut({ scope: 'local' })` if revoking on the server fails; the TanStack Query cache is cleared on `SIGNED_OUT`.                                                                                   |
| Password recovery                   | `resetPasswordForEmail(..., { redirectTo: origin + '/reset-password' })` → `/reset-password` exchanges the PKCE code, then `updateUser({ password })`. Invalid or expired link → "Link invalid or expired" (observed).                  |
| Session persistence                 | supabase-js `persistSession` (localStorage). `AuthProvider` restores it via `getSession()` while showing "Restoring your session".                                                                                                      |
| Token refresh                       | `autoRefreshToken: true`. The API client also retries once after `refreshSession()` on a 401 (unit tested).                                                                                                                             |
| Backend JWT validation              | `jose.jwtVerify` with `issuer`, `audience`, `requiredClaims: ['sub','exp']`, 5 s clock tolerance; claims schema needs a UUID `sub` and `role = 'authenticated'` (anon and service_role rejected). 17 unit tests.                        |
| JWKS                                | `createRemoteJWKSet(${SUPABASE_URL}/auth/v1/.well-known/jwks.json)` with 5 s timeout, 30 s cooldown, 10 min cache; ES256/RS256/EdDSA only. JWKS outage → 503 `SERVICE_UNAVAILABLE`, not 401.                                            |
| Legacy signing                      | When `SUPABASE_JWT_SECRET` is set, HS256 tokens are verified with it; otherwise HS256 is rejected. Asymmetric tokens always go to JWKS, so a project can migrate without code changes.                                                  |
| Issuer / audience                   | Issuer is derived as `${SUPABASE_URL}/auth/v1` (trailing slash stripped); audience comes from `SUPABASE_JWT_AUDIENCE`, default `authenticated`. Production requires https.                                                              |
| Profile upsert                      | `INSERT … ON CONFLICT (id) DO NOTHING` then `SELECT`, which is safe under concurrent requests. A foreign-key violation (user deleted from `auth.users`) → 401.                                                                          |
| Protected `/api/v1/me`              | `requireAuth` is mounted on all of `/api`, so auth is checked before 404s (route existence isn't revealed). Runtime: no token and bad token both → 401 with the standard body.                                                          |
| DB connection                       | `postgres` driver, `prepare: false` (Supabase transaction pooler compatible), 10 s connect timeout, pool of 10; `/readyz` pings with a 2 s timeout.                                                                                     |
| Drizzle migrations                  | `0000_create_profiles.sql` matches the schema (`db:generate` → no changes). `schemaFilter: ['public']`, so Supabase's `auth` schema is never managed. RLS is enabled with no policies.                                                  |

### Minor findings (not blocking)

1. **Raw network error text.** When Supabase is unreachable, the login page shows the browser's
   message "Failed to fetch" (observed). It works and doesn't crash, but the wording is poor. The
   other auth pages pass `error.message` through the same way. Suggested fix: map network-level
   `AuthError`s to "Can't reach the sign-in service. Check your connection and try again."
2. **Field errors stay after edits.** Validation messages only clear on the next submit (observed
   on `/login`). This is cosmetic.
3. **PKCE recovery is tied to one browser.** The reset link must be opened in the same browser
   that requested it, because the PKCE verifier is stored there. In any other browser the user
   sees "Link invalid or expired" and can request a new link. This is expected Supabase behaviour;
   it should go into the user-facing help.

### Unverified external integrations (all BLOCKED on a Supabase dev project)

1. Sign-up against Supabase Auth, including the confirmation email and its redirect.
2. Sign-in with a real password, and the session being stored.
3. Session restore after reload, plus automatic token refresh.
4. Sign-out revoking the session on the server.
5. Recovery email → `/reset-password` → PKCE exchange → `updateUser`.
6. Fetching the live JWKS, and accepting a real Supabase access token (correct `iss`/`aud`).
7. Legacy HS256 verification against a real project secret (only if the project uses it).
8. `npm run db:migrate` against Supabase Postgres, including the foreign key to `auth.users`.
9. Profile row created by the first real `GET /api/v1/me`.
10. `/readyz` returning 200 against a real database and JWKS.

---

## 4. Database test safety

| Check                                                 | Evidence                                                                                                                                                                                                                                                       | Status           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| No test can target `rain_db`                          | `assertSafeTestDatabaseUrl` rejects the name `rain_db` (and `postgres`) and requires a `_test` suffix. Unit test "the legacy rain_db" passes.                                                                                                                  | PASS             |
| Unsafe configurations refused                         | Also rejects non-postgres URLs, a URL equal to `DATABASE_URL`, and hosts other than localhost/127.0.0.1/::1 (or the Testcontainers host). Errors never contain the password (tested). 4 safety test cases pass.                                                | PASS             |
| Guard runs before any connection                      | In `tests/integration/global-setup.ts` the guard runs before `prepareDatabase()` in both paths. The test file only gets its URL through Vitest `inject('databaseUrl')`, which is set after the guard. Nothing loads `.env` or reads `DATABASE_URL` to connect. | PASS             |
| Unit tests never touch a database                     | No unit test imports `db/client.ts` or opens a connection; the app tests use a fake profile store and probe.                                                                                                                                                   | PASS             |
| Migrations run on an isolated DB                      | Setup drops and recreates `public`/`drizzle`/`auth` in the guarded DB, stubs `auth.users`, then applies `apps/server/drizzle` with the Drizzle migrator.                                                                                                       | PASS (by review) |
| Integration tests never hit production or a shared DB | Default is a throwaway `postgres:17-alpine` container named `rain_test`. The alternative path accepts only a local `*_test` database.                                                                                                                          | PASS (by review) |
| Integration tests executed                            | `npm run test:integration` → setup error: "Integration tests need Docker (for Testcontainers) or TEST_DATABASE_URL…", caused by "Could not find a working container runtime strategy". **Docker is not installed and was not installed, per instructions.**    | **BLOCKED**      |

One limitation by design: a local `*_test` database on the same Postgres server as `rain_db` would
be accepted. It is only dropped and recreated inside that database, so `rain_db` itself can't be
reached.

---

## 5. GitHub CI

`.github/workflows/ci.yml` was parsed locally with the `yaml` package: **no syntax errors**.
Triggers: `push` to `main`, and `pull_request`. Permissions: `contents: read`. A newer run on the
same ref cancels the older one.

| Requirement                        | Present | Where                                                                              |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| 1. `npm ci`                        | Yes     | both jobs, after `actions/setup-node@v4` (`node-version-file: .nvmrc`, npm cache)  |
| 2. TypeScript check                | Yes     | `verify` → `npm run typecheck`                                                     |
| 3. Lint                            | Yes     | `verify` → `npm run lint` (+ `format:check`)                                       |
| 4. Unit tests                      | Yes     | `verify` → `npm run test`                                                          |
| 5. Integration tests (isolated PG) | Yes     | `integration` → `npm run test:integration` (Testcontainers on the runner's Docker) |
| 6. Production build                | Yes     | `verify` → `npm run build`                                                         |

**Remote result: none.** The repository has no GitHub remote, and nothing was pushed (pushing
needs the owner's permission). The `actions/*@v4` majors work but may be behind current
releases. Check this the first time CI runs.

What's needed for a real CI result: see blocker B4.

---

## 6. Frontend verification

**Mode: placeholder only.** The Vite dev server (from the clean clone) ran with
`VITE_SUPABASE_URL=https://placeholder-project.supabase.co` and a dummy publishable key. That host
does not exist. **This shows rendering, validation, navigation and error handling only; it is not
verified authentication.** A second server ran with no Supabase variables at all.

| Route / behaviour                       | Observed                                                                                                                                             | Status     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Missing env vars                        | "Configuration required" page listing both missing `VITE_*` variables and the setup steps                                                            | PASS       |
| `/login`                                | Renders; empty submit → "Enter a valid email address", "Enter your password"; links to `/forgot-password` and `/register` work                       | PASS       |
| `/login` submit (Supabase down)         | Alert "Failed to fetch"; form stays usable (minor finding 1)                                                                                         | PASS       |
| `/register`                             | Renders; invalid email / short password / mismatched confirmation messages; "Sign in" link works                                                     | PASS       |
| `/forgot-password`                      | Renders; empty submit → email error; "Back to sign in" works                                                                                         | PASS       |
| `/reset-password` (no valid link)       | "Link invalid or expired" with a working "Request a new link"                                                                                        | PASS       |
| Protected route `/` signed out          | Redirects to `/login`                                                                                                                                | PASS       |
| Protected route `/` signed in           | Needs a real session                                                                                                                                 | BLOCKED    |
| 404 (`/does-not-exist`, `/nope/deeper`) | "Page not found" with "Go to overview"                                                                                                               | PASS       |
| Loading states                          | Spinners exist in code ("Restoring your session", "Signing in", etc.) but weren't visible: requests to the placeholder host failed too fast to catch | NOT TESTED |
| Console errors                          | Only `net::ERR_NAME_NOT_RESOLVED` for the placeholder host (expected). No React or app errors.                                                       | PASS       |

Screenshots from the implementation session are in `docs/screenshots/`.

---

## 7. Bundle assessment

The production JS bundle is a single chunk: **745.9 kB / 728.4 KiB minified, 217.1 kB / 210 KiB
gzip**. Vite warns because it is over its 500 kB default threshold. Bytes were attributed to
packages by decoding the bundle's source map:

| Package                                                      | Minified | Share | ~gzip  | Needed in Phase 2?                                              |
| ------------------------------------------------------------ | -------- | ----- | ------ | --------------------------------------------------------------- |
| react-dom                                                    | 202 KiB  | 27.8% | 62 KiB | Yes                                                             |
| @supabase/auth-js                                            | 97 KiB   | 13.4% | 22 KiB | Yes                                                             |
| react-router                                                 | 92 KiB   | 12.7% | 30 KiB | Yes                                                             |
| zod (v4 classic)                                             | 83 KiB   | 11.3% | 23 KiB | Yes (env and form validation, shared contracts)                 |
| sonner                                                       | 33 KiB   | 4.5%  | 9 KiB  | Yes (toasts)                                                    |
| @supabase/realtime-js + phoenix                              | 56 KiB   | 7.7%  | 17 KiB | **No** (bundled because `createClient` builds every sub-client) |
| @tanstack/query-core                                         | 30 KiB   | 4.2%  | 9 KiB  | Yes                                                             |
| tailwind-merge                                               | 27 KiB   | 3.7%  | 8 KiB  | Yes (shadcn `cn`)                                               |
| **app code (apps/web/src)**                                  | 24 KiB   | 3.3%  | 7 KiB  | Yes                                                             |
| @supabase/storage-js, postgrest-js, functions-js, iceberg-js | 47 KiB   | 6.4%  | 13 KiB | **No**                                                          |

**Conclusions**

- No single dependency is unusually large. The size is the normal base for React + router +
  Supabase + Zod + TanStack Query.
- About **103 KiB minified / ~30 KiB gzip (14%)** is Supabase code the app doesn't use yet
  (realtime, storage, postgrest, functions). It could be removed by using `@supabase/auth-js`
  directly, but realtime is a likely fit for the live dashboard in a later phase. **Recommendation:
  don't change this now.**
- **Lazy loading routes wouldn't help yet.** App code is only 24 KiB, and the first screen (the
  login page) already needs React, the router, Supabase Auth and Zod. Lazy loading will pay off
  once heavy dashboard views (charts, tables) arrive.
- **Not a Phase 2 blocker.** 210 KiB gzip is reasonable for an authenticated app.

**Follow-up for the dashboard phase:** lazy-load dashboard routes with `React.lazy`, put
long-lived vendor code in its own chunk for better caching, then re-measure. Decide about
`@supabase/auth-js` vs. `supabase-js` once the realtime decision is made. Raise
`build.chunkSizeWarningLimit` only with a measured budget, never just to hide the warning.

---

## 8. Acceptance matrix

### A. Monorepo foundation

| #   | Requirement                                                                    | Status  | Evidence                                                                        |
| --- | ------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------- |
| A1  | Workspace layout `apps/web`, `apps/server`, `packages/shared`, `docs`, `tests` | PASS    | Repository tree                                                                 |
| A2  | Root `package.json` + npm workspaces                                           | PASS    | `workspaces` field; workspace scripts run in clean clone                        |
| A3  | TypeScript configs, strict settings                                            | PASS    | `tsconfig.base.json` strict + `noUncheckedIndexedAccess` etc.; typecheck exit 0 |
| A4  | ESLint                                                                         | PASS    | `eslint.config.js`; lint exit 0                                                 |
| A5  | Formatting conventions                                                         | PASS    | Prettier + `.editorconfig`; `format:check` exit 0                               |
| A6  | Vitest                                                                         | PASS    | Unit and integration configs; 87/87                                             |
| A7  | Environment configuration + `.env.example`                                     | PASS    | Zod config, `.env.example` with no real values                                  |
| A8  | `.gitignore`, `.nvmrc`                                                         | PASS    | `.env*` ignored except the example; `.nvmrc` = 26                               |
| A9  | README                                                                         | PASS    | Commands, layout, API, security                                                 |
| A10 | GitHub Actions CI defined                                                      | PASS    | YAML valid; all six stages present                                              |
| A11 | GitHub Actions CI executed remotely                                            | BLOCKED | No remote; push needs the owner's permission                                    |
| A12 | Exact dependency versions, lockfile committed, reproducible install            | PASS    | `save-exact`; `npm ci` exit 0 in clean clone; identical build hashes            |

### B. Frontend foundation

| #   | Requirement                                     | Status     | Evidence                                                                      |
| --- | ----------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| B1  | Entry point + React Router                      | PASS       | Renders; route tree works                                                     |
| B2  | Authentication provider                         | PASS       | Code review; signed-out state observed                                        |
| B3  | Supabase client configuration                   | PASS       | PKCE / persist / auto-refresh; refuses privileged keys (unit tested)          |
| B4  | Login page (UI, validation, errors)             | PASS       | Observed in placeholder mode                                                  |
| B5  | Registration page (UI, validation)              | PASS       | Observed in placeholder mode                                                  |
| B6  | Password recovery pages (UI, invalid link)      | PASS       | Observed in placeholder mode                                                  |
| B7  | Protected routes — signed-out redirect          | PASS       | `/` → `/login` observed                                                       |
| B8  | Protected routes — signed-in access + app shell | BLOCKED    | Needs a real Supabase session                                                 |
| B9  | Authenticated API fetch wrapper                 | PASS       | 9 unit tests (bearer, envelope, errors, refresh-and-retry)                    |
| B10 | Global error handling                           | PASS       | Route error boundary, config page, 404, network-error alert (minor finding 1) |
| B11 | Loading states                                  | NOT TESTED | Present in code; not observed at runtime                                      |
| B12 | Empty states (overview)                         | BLOCKED    | Overview needs a signed-in session                                            |
| B13 | Dark interface, consistent components           | PASS       | Screenshots                                                                   |
| B14 | No monitoring dashboard started                 | PASS       | Overview is a placeholder shell                                               |

### C. Backend foundation

| #   | Requirement                                    | Status  | Evidence                                                   |
| --- | ---------------------------------------------- | ------- | ---------------------------------------------------------- |
| C1  | Server entry point                             | PASS    | `dist/api.js` started; "api listening"                     |
| C2  | Validated environment configuration            | PASS    | 12 unit tests; exit 1 with readable problems at runtime    |
| C3  | Helmet                                         | PASS    | CSP, HSTS, nosniff, etc. seen in response headers          |
| C4  | Restricted CORS                                | PASS    | Allowlist unit test                                        |
| C5  | Body size limit                                | PASS    | 413 unit test (100 kB)                                     |
| C6  | Rate limiting                                  | PASS    | Unit test; `RateLimit` headers seen                        |
| C7  | Request IDs                                    | PASS    | `X-Request-Id` seen; sanitising unit tested                |
| C8  | Pino logging with secret redaction             | PASS    | 3 unit tests; `authorization: "[REDACTED]"` seen in logs   |
| C9  | Centralised error handling + consistent format | PASS    | 500s hide details; standard `{ error: {...} }` bodies seen |
| C10 | `GET /healthz`                                 | PASS    | 200 `{"status":"ok"}` seen                                 |
| C11 | `GET /readyz` — not-ready path                 | PASS    | 503 with per-check status seen                             |
| C12 | `GET /readyz` — ready against real DB/JWKS     | BLOCKED | Needs Supabase project (ready path unit tested with fakes) |
| C13 | `GET /api/v1/me` requires auth                 | PASS    | 401 for no token / bad token seen; unit tests              |
| C14 | `GET /api/v1/me` with a real Supabase token    | BLOCKED | Needs Supabase project                                     |

### D. Authentication

| #   | Requirement                                               | Status  | Evidence                                                            |
| --- | --------------------------------------------------------- | ------- | ------------------------------------------------------------------- |
| D1  | Verify issuer, audience, expiry, subject                  | PASS    | Unit tests with local keys                                          |
| D2  | JWKS verification via jose (logic)                        | PASS    | Unit tests with a local JWKS; outage → 503                          |
| D3  | JWKS against the live Supabase endpoint                   | BLOCKED | Needs Supabase project                                              |
| D4  | Legacy HS256 support                                      | PASS    | Unit tests (accept with secret, reject without/with wrong one)      |
| D5  | Attach identity to request context                        | PASS    | `req.user`; `/me` unit test                                         |
| D6  | Reject invalid / expired tokens; 401 when unauthenticated | PASS    | Unit tests + runtime                                                |
| D7  | No privileged secrets in the browser                      | PASS    | Only `VITE_*` exposed; bundle scan finds no secret names; key guard |
| D8  | Real registration                                         | BLOCKED | Needs Supabase project                                              |
| D9  | Real login + session persistence                          | BLOCKED | Needs Supabase project                                              |
| D10 | Real logout                                               | BLOCKED | Needs Supabase project                                              |
| D11 | Real password recovery                                    | BLOCKED | Needs Supabase project + email delivery                             |
| D12 | Real token refresh                                        | BLOCKED | Needs Supabase project                                              |

### E. Database foundation

| #   | Requirement                            | Status  | Evidence                                       |
| --- | -------------------------------------- | ------- | ---------------------------------------------- |
| E1  | Drizzle + drizzle-kit configured       | PASS    | `db:generate` runs; config limited to `public` |
| E2  | `profiles` migration matches the spec  | PASS    | SQL review; `db:generate` → no schema changes  |
| E3  | Migration applied to a real database   | BLOCKED | No Supabase project, no Docker                 |
| E4  | Profile upsert on first access (logic) | PASS    | Code review; `/me` unit test with fake store   |
| E5  | Profile upsert against real Postgres   | BLOCKED | Integration tests need Docker                  |
| E6  | No future tables created               | PASS    | Only `profiles` in schema and migration        |

### F. Shared package

| #   | Requirement                         | Status | Evidence                                                       |
| --- | ----------------------------------- | ------ | -------------------------------------------------------------- |
| F1  | Zod schemas + inferred types        | PASS   | `@rain/shared`; 8 schema tests                                 |
| F2  | Profile schema and API error schema | PASS   | `profile.ts`, `errors.ts`                                      |
| F3  | Used by both web and server         | PASS   | Imports in `api-client.ts`, `routes/me.ts`, `routes/health.ts` |

### G. Worker foundation

| #   | Requirement                       | Status | Evidence                                                                               |
| --- | --------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| G1  | Loads and validates configuration | PASS   | Missing `DATABASE_URL` → exit 1 with message                                           |
| G2  | Starts independently              | PASS   | `dist/worker.js` → "worker started"                                                    |
| G3  | Logs startup and shutdown         | PASS   | "worker shutting down" → "worker stopped"                                              |
| G4  | Handles SIGTERM and SIGINT        | PASS   | Both signals fired in-process → exit 0 (Windows can't send POSIX signals from a shell) |
| G5  | No scheduled health checks yet    | PASS   | Heartbeat log only                                                                     |

### H. Testing requirements

| #   | Requirement                                  | Status  | Evidence                          |
| --- | -------------------------------------------- | ------- | --------------------------------- |
| H1  | Shared schema tests                          | PASS    | 8 tests                           |
| H2  | Environment validation tests                 | PASS    | 12 server + 3 web                 |
| H3  | JWT verification tests                       | PASS    | 17 tests                          |
| H4  | Missing / invalid / expired auth tests       | PASS    | app + verifier tests              |
| H5  | Protected `/api/v1/me` test                  | PASS    | app tests                         |
| H6  | Standard error response tests                | PASS    | app tests                         |
| H7  | Health endpoint tests                        | PASS    | app tests                         |
| H8  | Disposable-database integration setup exists | PASS    | Testcontainers + guarded fallback |
| H9  | Integration bootstrap refuses unsafe config  | PASS    | Guard + 4 safety test cases       |
| H10 | Integration tests executed                   | BLOCKED | Docker not installed              |

### I. Root commands

| #   | Command                    | Status     | Evidence                                                                                                                  |
| --- | -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| I1  | `npm install` / `npm ci`   | PASS       | `npm ci` exit 0 in clean clone (`npm install` itself not re-run)                                                          |
| I2  | `npm run dev`              | NOT TESTED | Parts ran on their own (Vite, built API); the combined `concurrently` script wasn't run, to avoid more orphaned processes |
| I3  | `npm run dev:worker`       | NOT TESTED | Built worker tested; the `tsx watch` script wasn't run                                                                    |
| I4  | `npm run typecheck`        | PASS       | exit 0                                                                                                                    |
| I5  | `npm run lint`             | PASS       | exit 0                                                                                                                    |
| I6  | `npm run test`             | PASS       | exit 0, 87/87                                                                                                             |
| I7  | `npm run test:integration` | BLOCKED    | Docker                                                                                                                    |
| I8  | `npm run build`            | PASS       | exit 0 (size warning, §7)                                                                                                 |
| I9  | `npm run db:generate`      | PASS       | exit 0, no schema changes                                                                                                 |
| I10 | `npm run db:migrate`       | BLOCKED    | Needs `DATABASE_URL` (Supabase project)                                                                                   |

**Totals: 0 FAIL · 16 BLOCKED · 3 NOT TESTED · all other rows PASS.**

---

## 9. Remaining blockers and how to clear each one

### B0 — Working checkout `node_modules` is broken (owner action, about 1 minute)

Caused by processes the auditor left running (§2a). In PowerShell:

```powershell
Stop-Process -Id 17508,10156,8540,18788
cd "C:\AntiGravity Projects\rain-api-observatory"
npm ci
```

If the PIDs have changed, find them with
`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId,CommandLine`.

### B1 — Supabase development project (clears B8, B12, C12, C14, D3, D8–D12, E3, I10)

1. Create a **development** project at supabase.com. Never use production.
2. In the repo root: `copy .env.example .env`, then fill `SUPABASE_URL`, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable/anon only) and `DATABASE_URL` (Connect → Session
   pooler, keep `?sslmode=require`). Leave `SUPABASE_JWT_SECRET` empty unless the project still
   uses legacy HS256 signing. Don't paste these values into chat or commit them.
3. Authentication → URL Configuration: Site URL `http://localhost:5173`; Redirect URLs
   `http://localhost:5173/` and `http://localhost:5173/reset-password`.
4. `npm run db:migrate`
5. `npm run dev`, then check:
   - `http://localhost:3000/readyz` → 200 `ready`
   - Register → confirm email → sign in → overview loads → `public.profiles` has your row
   - Reload: still signed in. Sign out: back at `/login`.
   - Forgot password → email link (same browser) → set new password → signed in
   - `curl -H "Authorization: Bearer <access token>" http://localhost:3000/api/v1/me` → 200.
     Don't share the token.
6. Then ask for the auth checks to be re-run and recorded here (D3, D8–D12, B8, B12, C12, C14, E3).

### B2 — Integration tests (clears E5, H10, I7)

Either option needs the owner's approval to install software:

- **Option A (recommended, matches CI):** install Docker Desktop for Windows (WSL 2 backend),
  start it, then `npm run test:integration`.
- **Option B:** install PostgreSQL locally, create a database ending in `_test` (e.g.
  `rain_obs_test`), then run
  `set TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/rain_obs_test` and
  `npm run test:integration`. The guard rejects anything not local, not `*_test`, `rain_db`, or
  equal to `DATABASE_URL`.

### B3 — Run the remaining root commands (clears I2, I3, B11)

After B0 and B1: run `npm run dev` and `npm run dev:worker`; with throttled network in DevTools,
confirm the "Signing in" / "Restoring your session" spinners appear.

### B4 — Remote CI (clears A11)

1. Create an empty GitHub repository (private is fine).
2. Give permission to add it as `origin` and push `main`, or run
   `git remote add origin <url>` and `git push -u origin main` yourself.
3. Both jobs (`verify`, `integration`) run automatically; record the run URL here. CI needs no
   secrets: integration tests use a container on the runner, not Supabase.

### Optional, non-blocking follow-ups

- Minor finding 1: friendlier wording for network-level auth errors (small change, 4 pages).
- Minor finding 2: clear a field's error when the user edits it.
- Bundle follow-up for the dashboard phase (§7).
- Review the `actions/*` major versions when CI first runs.

---

## Verdict

There are no **FAIL** results. Every requirement that can be checked on this machine passes, from
a clean clone of `1093b96`. What remains is external verification: a Supabase development
project, Docker (or a local Postgres) for integration tests, and a GitHub remote. Each needs the
owner's credentials, installation approval or push permission, and none suggests a code defect.
Phase 3 (Monitor CRUD) should not start until at least B0, B1 and B2 are done, so that real
authentication and the database layer are proven first.

**PHASE 2 CONDITIONALLY APPROVED**
