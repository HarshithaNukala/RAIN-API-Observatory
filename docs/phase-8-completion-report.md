# Phase 8 — Production Readiness and Final Verification

Date: 2026-11-19 · Branch: `feat/monitoring-foundation` · Nothing committed or pushed.

Status labels: **VERIFIED** (exercised and observed working in this phase), **IMPLEMENTED BUT
UNVERIFIED** (code and unit tests exist, but not exercised against the real system), **BLOCKED**
(could not be run; blocker stated), **NOT IMPLEMENTED**.

## 1. Overall V1 readiness

**Feature-complete and unit-verified, but not yet verified against PostgreSQL or the real
Supabase project.** Every V1 feature (auth, monitors, worker, incidents, analytics, notifications,
status pages) is implemented and passes 977 unit/component tests, typecheck, lint, format and a
production build. The two highest-risk verification steps — real PostgreSQL migrations and
integration suites, and an end-to-end run against the dev Supabase project — are **BLOCKED** by
the machine: no container runtime, no PostgreSQL, and no `.env` with development credentials.

Recommendation: suitable for an academic demo **after** the integration suite has run green once
against a disposable `_test` database (see §8). Until then, SQL-level behaviour (triggers,
constraints, `SKIP LOCKED`, percentile queries) is covered only by in-memory doubles that mirror it.

## 2. PostgreSQL migration results — BLOCKED

| Item                                                | Status  |
| --------------------------------------------------- | ------- |
| Apply migrations 0000–0007 to a `_test` database    | BLOCKED |
| Constraints, triggers, relationships                | BLOCKED |
| Concurrency (`FOR UPDATE SKIP LOCKED`), rollback    | BLOCKED |
| Outbox atomicity, status-page owner isolation (SQL) | BLOCKED |

Exact blocker (checked this phase): `docker`, `podman`, `psql`, `pg_ctl`, `postgres` not on PATH;
`wsl.exe` fails with `REGDB_E_CLASSNOTREG` (WSL not installed); no PostgreSQL or Docker service;
nothing listening on 5432; `TEST_DATABASE_URL` unset. The integration runner refuses to start
without one of them:

```
Integration tests need Docker (for Testcontainers) or TEST_DATABASE_URL pointing at a local
Postgres database whose name ends in "_test".
```

No system software was installed and no machine configuration changed (requires your approval).
The production and legacy (`rain_db`) databases were not touched.

## 3. Integration results — BLOCKED

Eight suites are written and ready (`tests/integration/`): profiles, monitors, monitor-checks,
monitoring-engine, incidents, analytics, notifications, status-pages (≈136 test cases). None could
run (§2). Their scenarios — concurrent claims, lease expiry, idempotent attempts, single active
incident (partial unique index), append-only `incident_events`, outbox uniqueness, same-owner
status-page trigger, RLS — are **IMPLEMENTED BUT UNVERIFIED** against PostgreSQL. The same
semantics are VERIFIED against in-memory doubles in the unit suite.

## 4. Browser verification

Real-application browser testing is **BLOCKED**: no `.env`, so the API cannot reach Supabase or a
database, and signing in through the hosted Supabase identity provider must be done by you.

Instead, every screen was exercised in the built-in browser through the dev UI harness
(`/harness.html`, clearly bannered "fake data — not connected to RAIN or Supabase"; excluded from
the production bundle — verified). Status: **VERIFIED with fake data; UNVERIFIED with real API
responses.**

| Page                                                                            | 375 px (mobile) | 1280 px (desktop) |
| ------------------------------------------------------------------------------- | --------------- | ----------------- |
| Monitors list (5 rows)                                                          | no overflow     | no overflow       |
| New monitor form                                                                | no overflow     | —                 |
| Monitor detail: Overview, Analytics, Notifications, History, Configuration tabs | no overflow     | —                 |
| Analytics overview (4 charts, sized to 293 px on mobile)                        | no overflow     | no overflow       |
| Incidents list and incident detail (timeline)                                   | no overflow     | no overflow       |
| Notifications (empty state)                                                     | no overflow     | —                 |
| Status pages list and editor (4 services)                                       | no overflow     | no overflow       |
| Public status page `/status/acme` (`noindex` meta)                              | no overflow     | no overflow       |

No console errors on any page. No layout defects were found, so no UI changes were needed.

## 5. Authentication and security findings

| Area                     | Result                                                                                                                      | Status                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| JWT verification         | jose + JWKS (or legacy HS256); anon/service-role tokens rejected; unauthenticated `/api/v1/monitors` → 401 on the built API | VERIFIED                       |
| Owner isolation          | Every repository query scoped by owner; cross-owner access returns 404 (unit tests)                                         | VERIFIED (in-memory)           |
| RLS                      | Enabled, no policies, on 11 of 11 tables (migration review)                                                                 | IMPLEMENTED BUT UNVERIFIED     |
| SSRF / DNS pinning / TLS | Safe dispatcher validates and pins DNS, ports 80/443, no redirects, SNI and certificate checks against hostname             | VERIFIED (unit + local target) |
| Webhook security         | HMAC-SHA256 `v1=` over `timestamp.body`, encrypted secrets, same transport as monitors                                      | VERIFIED (§6)                  |
| Secret encryption        | AES-256-GCM with key versions; header values write-only                                                                     | VERIFIED (unit)                |
| Rate limiting            | API and public status-page limiters; depends on correct `TRUST_PROXY`                                                       | VERIFIED (unit)                |
| Public data exposure     | Public view has no IDs, URLs, internal names or incident text; `no-store`, `X-Robots-Tag: noindex` (seen on built API)      | VERIFIED                       |
| Dependencies             | `npm audit --omit=dev`: 0 vulnerabilities                                                                                   | VERIFIED                       |
| Web client               | No `dangerouslySetInnerHTML`/`innerHTML`/`eval`; `noopener` on external links; only `VITE_*` publishable values bundled     | VERIFIED                       |
| Request IDs              | Incoming IDs validated `/^[A-Za-z0-9._-]{1,128}$/`                                                                          | VERIFIED                       |

**Fixed in this phase**

1. **SQL parameters in error logs.** A failing query on the API logged Drizzle's wrapper message,
   which includes the SQL and its parameters (monitor URLs, e-mails). The error handler now logs
   only the driver's code and message for query errors (`apps/server/src/safe-error.ts`,
   `http/error-handler.ts`). Test: `apps/server/src/http/error-logging.test.ts`.
2. **Bidirectional-override spoofing on public pages.** Status-page titles, descriptions and public
   service names now reject U+202A–U+202E and U+2066–U+2069 (`packages/shared/src/status-page.ts`);
   international text is still accepted. Tests in the same file.
3. **Log redaction gaps.** Added `apiKey`, `RESEND_API_KEY`, `ENCRYPTION_KEY`, `signingSecret` to
   Pino redaction paths (`apps/server/src/logger.ts`).

## 6. Email and webhook verification

| Item                                                          | Status                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Real email via Resend                                         | **UNVERIFIED** — no dev `RESEND_API_KEY` available; no email sent |
| Email adapter (request shape, idempotency key, error mapping) | VERIFIED (unit, fake fetch)                                       |
| Unconfigured email is recorded as failed, never as sent       | VERIFIED (unit; worker logs the warning at startup)               |
| Webhook to a controlled receiver                              | VERIFIED                                                          |

Webhook test (`apps/server/src/notifications/webhook-receiver.verification.test.ts`): two failed
checks open an incident → outbox row in the same transaction → real dispatcher → real webhook
sender over the **unmodified SSRF-safe transport** (an injected resolver returns a public address;
the pinned socket is diverted to a local receiver). The receiver verifies signatures with the
snippet published in `docs/notifications.md`. Observed: 503 then 202; one delivery ID on both
attempts; both signatures valid; tampered body and wrong secret rejected; DNS validated on each
attempt; history `[1, TEMPORARY_FAILURE, 503]`, `[2, SUCCESS, 202]`; custom auth header delivered;
no monitor URL or secret in the payload. No network security was relaxed.

## 7. Build and test results

| Command                    | Result                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run typecheck`        | pass                                                              |
| `npm run lint`             | pass                                                              |
| `npm run format:check`     | pass                                                              |
| `npm test`                 | pass — 43 files, **977 tests**                                    |
| `npm run test:integration` | **BLOCKED** — exit 1, no container runtime or `TEST_DATABASE_URL` |
| `npm run build`            | pass (Vite warns that the main chunk is 1.0 MB / 293 kB gzip)     |

## 8. Remaining blockers

1. **PostgreSQL for integration tests.** Choose one (needs your approval): install Docker Desktop
   (Testcontainers runs everything automatically), or install PostgreSQL locally and set
   `TEST_DATABASE_URL=postgresql://…/rain_test`. Then run `npm run test:integration`.
2. **Development credentials.** Create `.env` from `.env.example` with the **dev** Supabase
   project, then run `npm run db:migrate`, `npm run dev`, `npm run dev:worker` and sign in yourself
   in the browser to complete the real end-to-end walkthrough.
3. **Email.** A dev Resend key and a verified sender domain to send one test e-mail.
4. **Git.** No remote is configured and no commit identity was approved (open since Phase 3).

Non-blocking: the web bundle is a single 1 MB chunk (code-splitting would help load time).

## 9. Deployment readiness

| Item                                                                   | Status                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| Production build (shared, server, web)                                 | VERIFIED                                        |
| API starts alone from `dist/` (`NODE_ENV=production`)                  | VERIFIED                                        |
| Worker starts alone from `dist/`, backs off while the database is down | VERIFIED                                        |
| Fail-fast on missing configuration (exit 1, names only, no values)     | VERIFIED                                        |
| `/healthz` 200; `/readyz` 503 with per-check detail when not ready     | VERIFIED                                        |
| `/readyz` 200 against a real database                                  | BLOCKED (no database)                           |
| Graceful shutdown on SIGTERM (API: `api stopped`; worker: exit 0)      | VERIFIED                                        |
| Environment documentation (`.env.example`, deployment guide)           | VERIFIED — added `docs/deployment.md`           |
| Migration instructions                                                 | VERIFIED (documented); migration run BLOCKED    |
| Egress requirements                                                    | Documented in `docs/deployment.md`              |
| Hosted deployment                                                      | **NOT IMPLEMENTED** — nothing has been deployed |

README updated: RLS note corrected (11 of 11 tables) and link to the deployment guide.

## 10. Git branch and working tree

- Branch `feat/monitoring-foundation`, HEAD `b4869a8`; no remote configured.
- Working tree: all Phase 3–8 work is uncommitted (47 modified, 65 untracked paths); nothing was
  reset, switched, committed or pushed. The legacy Java repository was not modified.
- Phase 8 changes: `apps/server/src/safe-error.ts` (new), `http/error-handler.ts`, `logger.ts`,
  `monitoring/worker-engine.ts`, `packages/shared/src/status-page.ts`,
  `http/error-logging.test.ts` (new),
  `notifications/webhook-receiver.verification.test.ts` (new), `docs/deployment.md` (new),
  `README.md`, this report.
