# Phase 3 — Complete monitoring engine: completion report

Branch `feat/monitoring-foundation` (HEAD `b4869a8`), **uncommitted**, not pushed. `main` and the
legacy Java repository are untouched. Phase 4 has not been started.

## 1. Summary

The full lifecycle now runs: register → schedule → claim (`FOR UPDATE SKIP LOCKED`, lease token)
→ SSRF-safe execution → classify → record → health → next check → shown in the UI. Manual
**Check Now** goes through the same PostgreSQL queue. All local checks pass. The PostgreSQL
integration tests are written but **BLOCKED** (no Docker and no disposable database on this
machine).

## 2. Lifecycle integration

- `worker.ts` replaces the heartbeat stub: safe transport (exits 1 if unavailable), PostgreSQL
  store, executor, polling loop and graceful drain.
- `monitoring-store.ts`: claim CTE (manual first, then most overdue; bounded `LIMIT`; `SKIP
LOCKED`; lease set in the same autocommitted statement), header load after the claim, and a
  short completion transaction guarded by the lease token.
- `completion.ts`: pure decisions shared by the PostgreSQL and in-memory stores.
- `schedule.ts`: anchored cadence that skips missed intervals.

## 3. SSRF hardening

- The safe dispatcher is required in **every** environment. The `NODE_ENV` path is removed, so
  a MockAgent or a plain Agent gets `OUTBOUND_DISABLED`. There is no switch to disable it.
- Executor tests run through the real safe dispatcher against a local server
  (`test-support/local-target.ts`). ESLint forbids runtime code from importing `test-support`
  or undici mocks.
- `terminalConnectError` stops undici's silent reconnect on `UND_ERR_SOCKET` and `UND_ERR_INFO`,
  so each check makes exactly one connection attempt.
- HEAD checks use `reset: false` (documented trade-off). The rebinding test is stabilised.
- The classifier was reviewed (85 tests). Its deliberate blocks are AS112 and the whole of
  2001::/23.
- The docs separate application-level controls from infrastructure-level ones.

## 4. Database (migration `0004_monitoring_engine`, generated; 0000–0003 unchanged)

- **`monitors`:**
  - `lease_token`, with a CHECK pairing it with `lease_until`;
  - `manual_check_requested_at`, with a partial queue index;
  - `last_manual_check_at`.
- **`monitor_checks`:**
  - `source`, constrained to SCHEDULED/MANUAL by a CHECK;
  - `attempt_id`, unique, default `gen_random_uuid()`;
  - an index on (monitor, source, checked_at desc).
- `failure_reason` gains `CONFIGURATION_ERROR`; its constraint is replaced.
- Before the new pairing constraint is added, the migration clears any `lease_until` that has
  no token.
- No HTTP response means NULL status and NULL latency, still enforced by the existing CHECKs.
- `BLOCKED_DESTINATION` and `CONFIGURATION_ERROR` are health-neutral (`HEALTH_NEUTRAL_REASONS`).
- Worker writes keep `updated_at` unchanged.

## 5. Worker

- Polling and capacity:
  - polls about every 1 s;
  - concurrency 25 by default, and a claim never exceeds free capacity;
  - wakes when a slot frees up.
- Lease: 90 s by default, at least 45 s (30 s maximum timeout plus a 15 s margin). No
  transaction is held open during the HTTP request.
- Completion transaction:
  1. lock the row;
  2. a stale or deleted monitor writes nothing;
  3. insert the check with `ON CONFLICT (attempt_id) DO NOTHING`;
  4. apply health, unless the monitor was paused or the reason is health-neutral;
  5. set `status_changed_at` only when the status changes;
  6. compute the next check;
  7. clear the lease, guarded by the token.
- Pause and resume no longer clear the lease, so they can't cause an overlapping claim. Pause
  drops a queued manual request.
- Unexpected errors release the lease, advance the schedule and record nothing.
- Database outages are retried with exponential backoff (up to 30 s). Errors are logged by driver
  code and message only, never SQL or parameters.
- SIGTERM/SIGINT: stop claiming, drain within the grace period (35 s by default), then close.
- Configuration is validated: the encryption keys are now required by the worker, and the
  `WORKER_*` variables are documented in `.env.example`.
- Crash semantics are documented (at-least-once execution, at-most-once recording per attempt).

## 6. Executor integration

- Methods: GET, HEAD, OPTIONS, POST, PUT and PATCH. POST, PUT and PATCH need the persisted
  `allow_mutating_requests`.
- Limits: 32 KB request body, 64 KB response read. No retries.
- `refusedExecution`: a refusal becomes a recorded check with nothing sent.
  - An invalid destination becomes `BLOCKED_DESTINATION`.
  - Every other refusal becomes `CONFIGURATION_ERROR`.
  - `OUTBOUND_DISABLED` records nothing and releases the lease.
- Error messages are truncated to 500 characters. Secrets never appear in messages or logs.

## 7. Health

- Thresholds: failure 2, recovery 2.
- Failures: the first gives DEGRADED, the second DOWN.
- Recovery: the first passing check gives DEGRADED, the second HEALTHY (or DEGRADED if slow).
- A slow expected response passes but gives DEGRADED.
- UNKNOWN is kept until the first health-affecting check. PAUSED is shown from
  `enabled = false`, next to the stored status.

## 8. API

**`POST /api/v1/monitors/:monitorId/check`** returns 202 `QUEUED` and never sends the request.

| Situation                              | Response                                            |
| -------------------------------------- | --------------------------------------------------- |
| Monitor not found, or not the caller's | 404                                                 |
| Monitor paused                         | 409 `MONITOR_PAUSED`                                |
| A manual check is already queued       | 409 `CHECK_ALREADY_QUEUED`                          |
| Within 10 s of the last manual check   | 429 `CHECK_COOLDOWN`, with `Retry-After`            |
| Configuration the worker would refuse  | 422 `MONITOR_CONFIGURATION_INVALID`                 |
| Over the rate limit                    | 429 `RATE_LIMITED` (20/min per user, 30/min per IP) |

**`GET /api/v1/monitors/:monitorId/checks`:**

- owner-scoped, with 404 for other users' monitors;
- newest first, keyset cursor;
- `limit` 1–100 (default 25), optional `source` filter;
- safe fields only.

The summary contract gains `statusChangedAt`, `manualCheckQueuedAt` and `lastManualCheckAt`.

## 9. Frontend

- **Registry:** real health and Paused badges, last checked, and a new "Next check" column.
- **Details:**
  - health, with "since" when the status last changed;
  - the last check result (HTTP status or "No response", latency, sanitised error);
  - next check and request permission.
- **Check now:** QUEUED, then a poll every 1 s, then the real result. The wait is bounded at
  45 s, after which it says the worker may be offline. API refusals are explained.
- **History tab:** source filter, loading, empty and error-with-retry states, and "Load older
  checks".
- Health screens refresh every 30 s. No mock data in the app; the fake API is test-only.

## 10. Commands run

| Command                    | Result                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `npm run typecheck`        | PASS (0 errors)                                                        |
| `npm run lint`             | PASS                                                                   |
| `npm run format:check`     | PASS                                                                   |
| `npm test`                 | PASS, 736 tests in 25 files (engine tests 6/6 repeats stable; web 3/3) |
| `npm run build`            | PASS                                                                   |
| `npm run test:integration` | **BLOCKED**: no Docker and no `TEST_DATABASE_URL`                      |

**Worker startup** (built `dist/worker.js`, no reachable database):

- started and logged its settings;
- retried the claim with backoff (1 s, then 2 s), logging `ECONNREFUSED`;
- SIGINT gave a graceful stop with exit 0;
- an invalid lease (20 s) was rejected with exit 1.

**API startup** (built `dist/api.js`):

- listening, and `/healthz` returned 200;
- the new endpoints returned 401 without a token;
- SIGTERM gave a graceful stop with exit 0.

On Windows the signal was emitted inside the process by a test preload, so the real handlers ran.

## 11. Verification status

**Implemented and verified (unit and end-to-end tests without a database):**

- scheduling and skipped intervals;
- lease decisions: stale worker, re-claim after expiry, duplicate attempt;
- health transitions, and health-neutral SSRF and configuration refusals;
- pause or delete during a check;
- manual priority, cooldown, queued-request and paused rules;
- bounded concurrency, database-interruption recovery, graceful drain and abandonment;
- the full lifecycle through the real executor and safe transport against a local API;
- the routes: 202, auth, 404, rate limits and query validation;
- all UI states.

**Implemented but not runtime-verified:**

- the SQL store against PostgreSQL: the claim CTE, `SKIP LOCKED`, `ON CONFLICT`, and the
  `now()`/`make_interval` expressions;
- migration 0004 applied to a real database;
- the worker exiting when the safe transport is unavailable;
- the UI in a real browser against the real API (verified only by jsdom tests with the fake API).

**Blocked:**

- the PostgreSQL integration suite. It is written: `tests/integration/monitoring-engine.test.ts`
  (23 tests) plus the updated pause/resume test in `monitors.test.ts`.
- network-level egress restrictions (no deployment yet).

**Not implemented:**

- check-history retention;
- invalidating an in-flight check when its configuration is edited;
- a database role with only the worker's privileges.

## 12. Files

**New:**

- **Migration:** `apps/server/drizzle/0004_monitoring_engine.sql` and its snapshot.
- **Monitoring engine (`apps/server/src/monitoring/`):** `schedule.ts`, `completion.ts`,
  `monitoring-store.ts`, `worker-engine.ts`.
- **Test support:** `apps/server/src/test-support/in-memory-monitoring-store.ts`.
- **Web:** `checks.tsx` and `use-check-now-control.tsx`.
- **Tests:**
  - `schedule.test.ts`, `completion.test.ts`, `worker-engine.test.ts`;
  - `monitor-checks.test.tsx`;
  - `tests/integration/monitoring-engine.test.ts`.
- **Docs:** `docs/monitoring-engine.md`.

**Changed:**

- **Shared:** `monitor-check.ts`, `monitor.ts`, `errors.ts`.
- **Server:**
  - `db/schema.ts`, `config.ts`, `worker.ts`, `app.ts`, `http/error-handler.ts`;
  - monitors: repository, service and routes, plus their tests;
  - `monitoring/executor.ts`;
  - the in-memory repository;
  - `config.test.ts`.
- **Web:** `api.ts`, `format.ts`, `monitor-pages.tsx`, `monitors-page.tsx`, the fake API and
  the detail test.
- **Other:** `tests/integration/monitors.test.ts`, `.env.example`,
  `docs/security/monitor-network-security.md` and `docs/monitor-management.md`.

The Phase 3.1–3.3 work is preserved and built on, not rewritten.
