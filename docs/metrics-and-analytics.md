# Metrics and analytics

Every number on the Analytics pages is computed by PostgreSQL from persisted rows:
`monitor_checks` for checks and latency, `incidents` for incidents, and `monitors` for current
health. Nothing is estimated, sampled or filled in, and no analytics-specific tables exist.

## Time ranges

| Range | Buckets | Bucket size | Window                                       |
| ----- | ------- | ----------- | -------------------------------------------- |
| `24h` | 24      | 1 hour      | 23 full hours + the current partial hour     |
| `7d`  | 28      | 6 hours     | aligned to 00:00, 06:00, 12:00 and 18:00 UTC |
| `30d` | 30      | 1 day       | aligned to midnight UTC                      |

Each range consists of N UTC-aligned buckets ending with the bucket that contains "now":

- `from = floor(now / size) × size − (N − 1) × size`
- `to = now` (inclusive)

The newest bucket is partial, so a range covers between N − 1 and N bucket lengths.

- **Same window everywhere:** summary figures, charts and lists all use this one window, so they always agree.
- **Bucketing:** in SQL it uses `date_bin(size, ts, '1970-01-01 00:00:00+00')`, which produces exactly the boundaries computed by `resolveWindow` (`apps/server/src/analytics/analytics-window.ts`).
- **Time zones:** storage and aggregation are UTC. The web app shows bucket times in the viewer's time zone.

## Checks: what counts

| Check                                                           | Counts toward availability | Available |
| --------------------------------------------------------------- | -------------------------- | --------- |
| `SUCCESS` (expected status, fast)                               | yes                        | yes       |
| `DEGRADED` (expected status, slower than the latency threshold) | yes                        | **yes**   |
| `FAILURE` / `UNEXPECTED_STATUS` (a response, wrong status)      | yes                        | no        |
| `FAILURE` / `TIMEOUT`, `CONNECTION_ERROR`, `TLS_ERROR`          | yes                        | no        |
| `FAILURE` / `DNS_ERROR` (the target's name failed to resolve)   | yes                        | no        |
| `FAILURE` / `REQUEST_ERROR` (an unclassified transport failure) | yes                        | no        |
| `FAILURE` / `BLOCKED_DESTINATION` (SSRF guard refused it)       | **excluded**               | —         |
| `FAILURE` / `CONFIGURATION_ERROR` (RAIN refused to send it)     | **excluded**               | —         |

**About the excluded checks:**

- They are RAIN's own refusals: no request reached the monitored API, so they say nothing about it.
- They are the `HEALTH_NEUTRAL_REASONS` from the monitoring engine. That is the same set that never changes health or opens incidents, so analytics introduces no second vocabulary.

**There is no `counts_toward_uptime` column.**

- The engine already records why each check failed, and eligibility is derived from that in one SQL expression (`ELIGIBLE` in `analytics-repository.ts`).
- A stored flag could drift from the reason it duplicates, so no migration was added.
- The DNS distinction is already in the data:
  - a hostname that resolves to a private address is `BLOCKED_DESTINATION`, which is excluded;
  - a genuine resolution failure is `DNS_ERROR`, which counts.

## Metric definitions

### Check-based availability

```
availability % = available checks / counted checks × 100
```

- If there are no counted checks, availability is **`null`**, shown as **"No data"** and never as 0 %.
- It is check-based:
  - paused time and time with no worker running produce no checks, so they are neither "up" nor "down";
  - a monitor checked every 10 minutes contributes fewer checks than one checked every minute.
- The page labels it "check-based" everywhere it appears.
- The API returns three decimals. The UI rounds down to two decimals, so a period with any failure never shows "100%".

The failure rate is `failed / counted × 100`, with the same null rule.

### Check counts

| Field        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `recorded`   | all checks in the window                                          |
| `eligible`   | checks that count (all except RAIN refusals)                      |
| `successful` | counted checks with the expected status (`SUCCESS` or `DEGRADED`) |
| `failed`     | counted checks with `FAILURE`                                     |
| `slow`       | `DEGRADED` checks (a subset of successful)                        |
| `excluded`   | RAIN refusals (`recorded − eligible`)                             |

### Latency

Latency is time to response headers, in milliseconds, from `monitor_checks.latency_ms`.

- **Which checks count:** every check that received response headers, including unexpected statuses.
- **Missing responses:** a check with no response has NULL latency. It is left out, never counted as 0.
- **Statistics:**
  - Average, min and max use `avg`, `min` and `max` over non-NULL values.
  - P50, P95 and P99 use PostgreSQL's exact ordered-set aggregate `percentile_cont(p) WITHIN GROUP (ORDER BY latency_ms)`. That is linear interpolation between the closest ranks: position `(n − 1) × p`, the same definition as NumPy's default. NULLs are ignored by the aggregate.
- **Per-bucket P95** is computed from that bucket's own checks. Percentiles are never averaged across buckets, and the period's P95 is computed from all checks in the period.
- **Rounding:** 0.1 ms. The UI shows `ms` below one second and `s` above.
- **No responses:** if no check received a response, every latency statistic is `null` ("No data").

### Failures

- Failures are counted by `failure_reason` using the engine's vocabulary.
- **Ordering:** by count descending, then reason ascending, so the order is deterministic.
- Refusals are listed separately and marked `excludedFromAvailability`.
- **"Most failed checks":** the five monitors with the most counted failures in the window. Ties are broken by name, then ID.

### Incidents

| Field                 | Definition                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `opened`              | incidents whose `started_at` is in the window                                                |
| `resolved`            | incidents whose `resolved_at` is in the window                                               |
| `currentlyOpen`       | OPEN or ACKNOWLEDGED right now (not limited to the window)                                   |
| `averageResolutionMs` | mean of `resolved_at − started_at` over the incidents resolved in the window; `null` if none |

- **Open incidents** never contribute to the resolution time.
- **Incidents spanning the window start:**
  - An incident that started before the window but resolved inside it counts as resolved, and its full duration is averaged.
  - It does not count as opened in the window.
- **"Most incidents":** the five monitors with the most incidents opened in the window, ordered by count, then name, then ID.

### Monitor counts (overview)

- Current state from `monitors`: total, healthy, degraded, down and unknown (enabled monitors only), plus paused.
- These are not limited to the window.

## Time series

- **What a bucket carries:** counts (`eligible`, `successful`, `failed`, `slow`, `excluded`), `availabilityPercent`, `avgLatencyMs`, `p95LatencyMs`, `incidentsOpened` and `incidentsResolved`.
- **Empty buckets** are returned with zero counts (nothing was recorded, which is a fact). Their availability and latencies are `null`, so charts draw a **gap**, never a fabricated 0 % or 0 ms.
- **Charts:**
  - availability history (line, 0–100 %);
  - response time (average and P95 lines);
  - check activity (stacked successful and failed bars);
  - incident history (opened and resolved bars).
- **Chart features:** legends for two-series charts, hover tooltips, whole-number axes for counts, and a "Show data table" view of every bucket.
- **Colours:** the validated dataviz reference palette (dark steps) on the app's dark card surface. All checks pass, including colour-vision-deficiency separation and contrast.

## API

Both endpoints are under `/api/v1` and require a bearer token. `range` is `24h` (the default), `7d` or `30d`; anything else returns 400 `VALIDATION_ERROR`.

| Endpoint                                  | Returns                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /analytics/overview?range=`          | `window`, `monitors` counts, `checks`, `latency`, `series`, `failureReasons`, `incidents`, `topFailingMonitors`, `topIncidentMonitors` |
| `GET /monitors/:monitorId/metrics?range=` | `window`, `monitor`, `checks`, `latency`, `series`, `failureReasons`, `incidents`                                                      |

**Ownership:**

- Every SQL statement filters by `monitors.owner_id` or `incidents.owner_id`.
- A monitor owned by someone else returns 404 `MONITOR_NOT_FOUND`, the same as a missing or malformed ID.

**Bounded responses:**

- at most 30 buckets;
- at most eight failure reasons (the size of the vocabulary);
- at most five monitors per top list.

**Consistency:** each response is built inside one `REPEATABLE READ, READ ONLY` transaction, so its parts are consistent.

Contracts are in `packages/shared/src/analytics.ts`.

## SQL strategy and performance

**Aggregation stays in PostgreSQL.** Node never receives raw check rows. Each response runs a fixed set of aggregate queries:

- totals;
- per-bucket metrics;
- failure reasons;
- incident totals and buckets;
- for the overview: monitor counts and the two top lists.

They use `count(*) FILTER (WHERE …)`, `avg`, `min`/`max`, `percentile_cont` and `date_bin`.

**Indexes:**

- **Check queries** join `monitors` (by `owner_id`, using `monitors_owner_id_idx`) to `monitor_checks` with `checked_at` bounds. Each monitor's rows come from `monitor_checks_monitor_checked_idx (monitor_id, checked_at DESC)` as an index range scan.
- **Incident queries** use the existing `incidents_owner_*` indexes.
- **No new index or migration was needed.**

**Cost:** exact aggregation is proportional to the checks in the window. The worst case is one monitor checked every 30 s over 30 days, about 86,400 rows. The percentile aggregates sort those rows; at V1 sizes (a handful of monitors per user) that is milliseconds to tens of milliseconds.

**When rollups become worthwhile:**

- `EXPLAIN ANALYZE` of the overview exceeds roughly 200 ms at p95 for real users;
- or a user's 30-day window exceeds a few million checks (around 50+ monitors at a one-minute interval);
- or retention grows beyond 30 days with longer ranges.

**What rollups would look like:** hourly rollups per monitor would store counts, sums and min/max (exactly mergeable). They would also store a mergeable percentile sketch (for example t-digest or DDSketch), because exact percentiles can't be merged from hourly percentiles. Rolled-up percentiles would then be approximations and must be labelled as such, with their error bound documented. Until then, every percentile here is exact.

## Testing

```bash
npm test
```

| Test file                                            | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/analytics/analytics.test.ts`        | Window and bucket alignment for all three ranges; empty buckets; availability (all successful, mixed, slow, only failures, SSRF and configuration exclusions, zero eligible, window bounds, several monitors, owner isolation); latency (avg, min, max, P50, P95, P99, NULLs, unexpected statuses, per-bucket P95); failure ordering and top lists; incidents (open, resolved, durations, window boundaries, buckets, ranking); paused monitors; users with no monitors. It runs against an in-memory reference implementation of the same SQL semantics, including `percentile_cont` interpolation. |
| `apps/server/src/analytics/analytics-routes.test.ts` | Authentication, the range default and validation, 404s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/src/features/analytics/analytics.test.tsx` | Summary cards, latency, failure and incident cards, the four charts, the table view, tooltips, range changes, no-data and empty states, loading, errors with retry, navigation, and the monitor Analytics tab.                                                                                                                                                                                                                                                                                                                                                                                       |

```bash
npm run test:integration
```

`tests/integration/analytics.test.ts` runs the real aggregation SQL on PostgreSQL through the HTTP API. It covers:

- availability and the exclusions;
- exact percentiles over 101 values;
- per-bucket P95 and UTC alignment;
- window bounds and incident boundaries;
- ownership and isolation, plus a user with no monitors;
- top-list ordering;
- cascade on monitor deletion.

It needs Docker (Testcontainers) or `TEST_DATABASE_URL` pointing at a local `*_test` database.

## Known limitations

- **Availability is check-based, not time-based:** it weights each check equally, and unmonitored time is invisible.
- **Window boundaries:** the "last 24 hours" window starts at the top of an hour (23–24 hours long); the same applies to 7 and 30 days.
- **Incident series:** these count incidents opened or resolved in each bucket. They don't show "incidents in progress" per bucket.
- **No configurable ranges:** there are no custom date ranges and no time-zone-aligned (local-midnight) buckets.
- **No retention:** check history grows without limit, so query cost grows with check volume inside the window, not with total history.
