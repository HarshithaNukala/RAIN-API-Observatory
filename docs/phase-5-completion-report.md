# Phase 5: Metrics and analytics completion report

## 1. Executive summary

RAIN now has an Analytics dashboard (`/app/analytics`) and an Analytics tab on every monitor.
Every figure is aggregated by PostgreSQL from persisted checks and incidents:

- check-based availability;
- exact latency percentiles;
- failure breakdowns;
- incident statistics;
- four time-series charts.

What's verified:

- All local checks pass: typecheck, lint, format, 838 unit/component tests, build.
- The UI was also checked visually in a real browser, using the dev-only harness with fake data, at desktop and phone widths. That check found and fixed three layout bugs.

What's not verified:

- The aggregation SQL has **not** run against PostgreSQL here. The integration suite is written and **BLOCKED**: there is no Docker and no disposable test database.

No commit, no push, no new migration. Phase 6 has not been started.

## 2. Features implemented

- **Overview** (`GET /api/v1/analytics/overview`):
  - Monitors: total, healthy, degraded, down, unknown, paused.
  - Checks: availability and counted, successful, failed, slow and excluded counts.
  - Latency: avg, min, max, P50, P95, P99.
  - Per-bucket series.
  - Failure reasons.
  - Incident statistics.
  - Top-5 monitors by failures and by incidents.
- **Per monitor** (`GET /api/v1/monitors/:monitorId/metrics`): the same statistics for one owned monitor.
- **Ranges:**
  - 24h: 24 hourly buckets.
  - 7d: 28 six-hour buckets.
  - 30d: 30 daily buckets.
  - All UTC-aligned.
- **Web:**
  - an Analytics page in the main navigation, with the range kept in the URL;
  - the monitor Analytics tab;
  - four charts with legends, tooltips, whole-number axes for counts and a data-table view;
  - loading, empty, "No data" and error-with-retry states.

## 3. Database changes

**None.** No migration was needed:

- **Eligibility** comes from the existing `failure_reason` vocabulary. It is the engine's `HEALTH_NEUTRAL_REASONS`, so there's no second vocabulary and no new `counts_toward_uptime` column that could drift from it.
- **Indexes:** the existing ones cover the access paths:
  - checks: `(monitor_id, checked_at DESC)` reached through `monitors(owner_id)`;
  - incidents: `incidents(owner_id, …)`.
- **Rollups:** none. The docs say when hourly rollups (with mergeable percentile sketches) become worthwhile, and that any rolled-up percentile would be an approximation and must be labelled as one.

## 4. Metric definitions and methodology

The full definitions are in `docs/metrics-and-analytics.md`.

- **Availability** = (`SUCCESS` + `DEGRADED`) / counted checks × 100.
  - Counted checks are all checks except `BLOCKED_DESTINATION` and `CONFIGURATION_ERROR`.
  - Unexpected status, timeout, connection, TLS, DNS and request errors count as failures.
  - With no counted checks the value is `null`, shown as "No data", never 0 %.
  - It is labelled check-based everywhere.
  - The UI rounds down, so a period with any failure never shows 100 %.
- **Latency:**
  - Uses checks with response headers only, including unexpected statuses. NULL latency is excluded, never treated as 0.
  - Percentiles use `percentile_cont` (exact, linearly interpolated).
  - P95 per bucket is computed from that bucket's checks; percentiles are never averaged.
- **Failures:**
  - Grouped by `failure_reason`, ordered by count then reason.
  - Excluded refusals are listed separately and marked.
- **Incidents:**
  - Opened and resolved are counted by `started_at` and `resolved_at` in the window; currently open is a snapshot.
  - Average resolution covers incidents resolved in the window (started → resolved). Open incidents are never included.
- **Charts:** empty buckets carry zero counts but `null` rates and latencies, drawn as gaps.

## 5. API endpoints

| Endpoint                                         | Notes                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /api/v1/analytics/overview?range=`          | owner-scoped; `range` is 24h (default), 7d or 30d; other values give 400  |
| `GET /api/v1/monitors/:monitorId/metrics?range=` | 404 `MONITOR_NOT_FOUND` for missing, malformed or another user's monitors |

- Each response is built in one read-only REPEATABLE READ transaction.
- Response size is bounded: at most 30 buckets, at most 8 failure reasons, and 5 monitors per top list.

## 6. Frontend pages and charts

- `/app/analytics`:
  - seven summary cards;
  - the range selector;
  - availability history, response time (avg and P95), check activity (stacked) and incident history (grouped);
  - response-time, failures and incidents cards;
  - most failed checks and most incidents lists.
- **Monitor details → Analytics tab:**
  - ten summary cards: current health, availability, avg, P50, P95, P99, total checks, failed checks, failure rate, open incidents;
  - the four charts;
  - the failures and incidents cards, with a link to the monitor's incidents.
- **Charts:**
  - Built as dependency-free SVG.
  - The colours come from the dataviz reference palette and passed the validator against the real card surface `#11161e`. The app's own success/destructive pair failed it, so it isn't used.
  - Charts resize to their container.

## 7. Test commands and results

| Command                      | Result                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| `npm run typecheck`          | PASS (0 errors)                                                          |
| `npm run lint`               | PASS                                                                     |
| `npm run format:check`       | PASS                                                                     |
| `npm run test`               | PASS: 838 tests in 32 files (47 new; web 3/3 repeat runs stable)         |
| `npm run test:integration`   | **BLOCKED** (see section 8)                                              |
| `npm run build`              | PASS                                                                     |
| `git diff --check`           | clean                                                                    |
| Built API smoke test         | analytics routes return 401 without a token; clean SIGTERM shutdown      |
| Browser (harness, fake data) | desktop 1400 px and phone 375 px: no overflow, charts sized to container |

**Bugs found and fixed:**

- **`checks` included latency fields.** `checkStats` leaked the latency fields into the `checks` object. Caught by a unit test.
- **Charts didn't fit their containers.** In the browser, charts overflowed their cards and couldn't shrink on phones; inline-size containment and a synchronous first measurement fixed this.
- **Unreadable axis ticks.** Count axes showed rounded duplicate ticks; they now use whole-number 1/2/5 steps.

**Baseline flake (corrected in Phase 6):**

- A TLS test in `safe-transport.test.ts` failed once in the baseline full run. It could not be reproduced in seven further runs.
- The explanation given here in Phase 5 (a slow handshake classified as DEGRADED) and the assertion change made then were **wrong**.
- Phase 6 captured the real failure: an intermittent `CONNECTION_ERROR` after about 49 ms.
- The real cause: the test HTTPS server sent `Connection: close` and closed the TLS socket immediately, which can reset the connection on Windows loopback.
- Fix: the test server no longer forces the close, and the original strict `SUCCESS` assertion is restored. The product code is unchanged; it passed 6 of 6 full runs after the fix.

## 8. Blocked tests

- **`npm run test:integration` is BLOCKED.**
  - Docker isn't installed, so Testcontainers finds no container runtime, and `TEST_DATABASE_URL` is unset.
  - New and unrun: `tests/integration/analytics.test.ts`, which covers availability and exclusions, exact percentiles, per-bucket P95 and UTC alignment, window and incident boundaries, ownership, top-list ordering and cascade.
  - Also unrun: the Phase 3 and 4 suites.
- **Unverified as a result:**
  - The aggregation SQL itself: `FILTER`, `percentile_cont`, `date_bin` and the incident `UNION ALL`.
  - Its correctness on real PostgreSQL. The unit tests prove the definitions only through an in-memory reference implementation of the same semantics.
- **Not verified in the real application:** the analytics UI against the real API and Supabase sign-in. The browser check used the dev harness with fixture data.

## 9. Known limitations

- **Check-based availability:** each check has equal weight; paused and unmonitored time is invisible.
- **Windows** start on bucket boundaries, so "last 24 hours" is 23–24 hours long.
- **Incident series** count openings and resolutions per bucket, not incidents in progress.
- **Ranges:** no custom ranges and no local-time-zone buckets.
- **No retention:** check history grows without limit.
- **Exact aggregation** cost grows with the number of checks in the window; rollups are documented for when that matters.
- **Earlier phases:** the Phase 3 and 4 limitations still apply.

## 10. Git branch and working tree

- **Branch:** `feat/monitoring-foundation`, HEAD `b4869a8`.
- **Uncommitted:** Phases 3, 4 and 5 are all uncommitted, and nothing is pushed.
- **Legacy Java repository:** no changes.
- **Not touched:** old migrations; no files were added outside the project repository.
