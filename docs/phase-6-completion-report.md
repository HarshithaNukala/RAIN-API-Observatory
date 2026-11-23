# Phase 6: Notification system completion report

## Summary

**Done and verified with no database:**

- Incidents now trigger email and signed-webhook notifications through a transactional outbox.
- An asynchronous dispatcher in the worker delivers them, with leases, bounded retries and a delivery history.
- Owners configure the channels per monitor in the web app.
- All local checks pass: typecheck, lint, format, 923 tests, build.
- The built worker and API were started and stopped cleanly.
- The settings UI was checked in a real browser (dev harness, fake data).

**Blocked:** the PostgreSQL integration suites, including the outstanding Phase 3–5 suites. There is no Docker and no disposable test database.

**Not exercised:** no real email was sent, because there's no Resend key and tests never send.

Nothing is committed or pushed, and Phase 7 has not been started.

## 1. Features implemented

- **Events:** `INCIDENT_CREATED` and `INCIDENT_RESOLVED` only. No notification for single failed checks or repeated failures.
- **Per-monitor preferences:** email on/off (to the owner's account address); a webhook (URL, enabled flag, optional encrypted authentication header, a RAIN-generated signing secret shown once); rotation and removal.
- **Defaults:** nothing is enabled until configured.
- **Transactional outbox:** delivery rows are inserted in the incident's completion transaction, unique per `(event_id, channel)`.
- **Email:** a provider interface with a Resend REST adapter (no SDK); HTML and plain-text templates with escaping; an idempotency key.
- **Webhooks:** delivered through the SSRF-safe transport; HMAC-SHA256 signatures with timestamp and delivery ID; no redirects.
- **Dispatcher:**
  - bounded concurrency and `SKIP LOCKED` claims;
  - leases with expiry recovery, attempts counted at claim;
  - exponential backoff with equal jitter, 8 attempts maximum;
  - temporary and permanent failure classes;
  - graceful drain.
- **API:** settings get and put; delivery list with filters and pagination; details with attempt history; retry of failed deliveries.
- **Web:** a monitor **Notifications** tab; a **Notifications** history page in the navigation; delivery details with attempts and **Retry**.

## 2. Database migrations

`0006_notifications` (generated, new tables only; 0000–0005 unchanged):

- **`monitor_notification_settings`**:
  - CHECKs: a configured webhook is complete, an enabled one is configured, the header is all-or-nothing and needs a webhook;
  - the secret and header are stored only encrypted.
- **`notification_deliveries`** (the outbox):
  - unique `(event_id, channel)`;
  - partial indexes for the due and processing queues, plus an owner history keyset index;
  - CHECKs: vocabularies, lease and token pairing, PROCESSING ⇔ leased, SENT ⇔ `delivered_at`.
- **`notification_attempts`**: unique `(delivery_id, attempt_number)`.
- **RLS** is enabled on all three tables, as on every other table.

## 3. Email integration

**Resend was not installed or configured in the repository.** I added an adapter that calls the REST API directly.

**Configuration:** `RESEND_API_KEY` and `NOTIFICATION_EMAIL_FROM` are server-side only; `APP_BASE_URL` provides the link.

**Without configuration:**

- Emails are recorded as **FAILED** with "Email delivery is not configured", never as sent.
- The settings page shows a warning, and the worker logs one at startup.

**Errors:**

- Provider errors keep only a short error name, never the raw response.
- 4xx is permanent; 408, 429, 5xx and network errors are temporary.

**Not verified:** a real send through Resend. It needs an account, a verified domain and a key.

## 4. Webhook security

**No protection was relaxed.** The same SSRF-safe transport as monitor checks:

- every DNS answer is validated per connection, and mixed or private answers refuse the host;
- the IP is pinned, with SNI and TLS verification;
- ports 80/443 only, http/https only;
- no private, metadata or local literals or names, no credentials in URLs;
- no proxies and no redirects.

**URL checks happen at save time (shared Zod schema) and again at send time.**

**The sender refuses any non-safe dispatcher.**

**Secrets:**

- Signing secrets and authentication headers are encrypted (AES-256-GCM, with key rotation).
- The secret is shown once and never logged.
- Only the host appears in errors, logs and history.

**Signatures:** `X-Rain-Signature: v1=HMAC-SHA256(secret, "<ts>.<body>")` with `X-Rain-Timestamp` and `X-Rain-Delivery`. Verification code and the replay guidance are in the docs.

**Tested against the real safe transport:**

- private and mixed DNS answers;
- rebinding between deliveries;
- literal and port refusals;
- redirects not followed;
- forged header names;
- non-safe transports refused.

## 5. Outbox and retry architecture

- **Queueing** happens in the check-completion transaction. A rollback leaves no jobs, and duplicate events or attempts can't create a second job (unique index plus the attempt-ID guard).
- **Dispatching** runs in the worker on its own loop:
  1. claim with `FOR UPDATE SKIP LOCKED`, take a lease, count the attempt;
  2. send outside any transaction;
  3. complete in a short, lease-token-guarded transaction that records the attempt row and the new status.
- **Retries:** 30 s × 2ⁿ backoff with equal jitter, capped at 6 h, 8 attempts maximum. Exhausted or permanent failures become **FAILED** and stay visible.
- **Expired leases** are re-claimed. An expired lease with no attempts left becomes FAILED. Stale completions are rejected.
- **At-least-once** delivery is documented. It is mitigated by delivery IDs and provider idempotency, with no exactly-once claim.

## 6. API endpoints

`/api/v1`, authenticated and owner-scoped; another user's resources return 404:

- `GET /monitors/:monitorId/notifications`
- `PUT /monitors/:monitorId/notifications` (returns `signingSecret` once)
- `GET /notifications?status&channel&monitorId&limit&cursor`
- `GET /notifications/:id` (includes the attempt history)
- `POST /notifications/:id/retry` (FAILED only, otherwise 409 `NOTIFICATION_NOT_RETRYABLE`)

## 7. Frontend functionality

- **Monitor Notifications tab:**
  - email toggle (with the account address, disabled without one);
  - a provider-not-configured warning;
  - webhook URL and enabled toggle, write-only authentication header;
  - security guidance;
  - the one-time signing-secret display with Copy;
  - rotate and remove;
  - server validation errors on the fields;
  - loading and error-with-retry states.
- **Notifications page:**
  - event, monitor, incident, channel and destination, status, attempts, last attempt, delivered, safe error;
  - status and channel filters, plus a monitor filter;
  - "Load more";
  - loading, empty and error-with-retry states.
- **Delivery details:** the attempt table and **Retry delivery**.

## 8. Tests and actual results

| Command                    | Result                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | PASS (0 errors)                                                                                                                                                                   |
| `npm run lint`             | PASS                                                                                                                                                                              |
| `npm run format:check`     | PASS                                                                                                                                                                              |
| `npm run test`             | PASS: 923 tests in 38 files (85 new; full suite 3/3 repeat runs)                                                                                                                  |
| `npm run test:integration` | **BLOCKED** (section 9)                                                                                                                                                           |
| `npm run build`            | PASS                                                                                                                                                                              |
| `git diff --check`         | clean                                                                                                                                                                             |
| Built worker               | Starts both loops. Warns that email is unconfigured. Backs off on database errors, logging `ECONNREFUSED`. SIGINT drains with exit 0. Invalid notification settings are rejected. |
| Built API                  | New routes return 401 without a token; clean SIGTERM                                                                                                                              |
| Browser (harness)          | Notifications tab renders all controls; no overflow                                                                                                                               |

**Fixed along the way:**

- **Phase 3 TLS test flake, real root cause.** The test server's `Connection: close` raced into a reset on Windows. The test server was fixed and the strict assertion restored, and the Phase 5 report's wrong explanation was corrected.
- **Test-side issues:**
  - the HTTP test helper and the API client lacked PUT;
  - the in-memory twin used the wall clock;
  - a fake UUID had an invalid variant.
- **The one-time signing secret could vanish after a save.** Its state was lifted out of the remounting form.
- **A form test hit the default timeout under full-suite load.** The existing "create monitor" UI test took about 2 s alone but over 5 s in a parallel run, so it now has an explicit 15 s budget. The full suite then passed 3 of 3 runs.

## 9. Infrastructure blockers

- **PostgreSQL integration is BLOCKED.**
  - Docker isn't installed, there's no local PostgreSQL, and `TEST_DATABASE_URL` is unset.
  - Written but not run: `tests/integration/notifications.test.ts`, covering the outbox in the real completion SQL, uniqueness, CHECKs, encryption at rest, `SKIP LOCKED` across two connections, lease recovery, retry scheduling and the API with two users.
  - Also still unverified: the Phase 3–5 suites (`monitoring-engine`, `incidents`, `analytics`).
  - Migrations 0004–0006 have never been applied to a real database.
- **Email: no real send.** There's no Resend account or key. The adapter is verified only against `MockAgent`.
- **Not tested in a real browser against the real API with Supabase sign-in.**

## 10. Known limitations

- **No other channels:** no Slack (out of scope), no SMS, digests, quiet hours or per-severity routing.
- **Current settings at send time:** a webhook removed or disabled after queueing fails its pending deliveries, and email goes to the current address.
- **No retention:** delivery history grows without limit.
- **Resend idempotency** has limited memory; a manual retry much later can send a second email.
- **Earlier phases:** the Phase 3–5 limitations still apply.

## 11. Git branch and working tree

- **Branch:** `feat/monitoring-foundation`, HEAD `b4869a8`.
- **Uncommitted:** Phases 3–6 are all uncommitted, and nothing is pushed.
- **Legacy Java repository:** no changes.
- **Old migrations:** untouched.
- **No new dependencies.**
