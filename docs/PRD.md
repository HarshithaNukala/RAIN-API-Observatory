# Product Requirements Document (PRD)

## RAIN — API Observatory

| Item     | Value                                                                    |
| -------- | ------------------------------------------------------------------------ |
| Product  | RAIN API Observatory (V1)                                                |
| Codebase | TypeScript rebuild (npm workspaces: API, worker, web app, shared types)  |
| Related  | [High-Level Design](HLD.md) · [Low-Level Design](LLD.md)                 |
| Status   | Feature-complete for V1; PostgreSQL integration verification outstanding |

---

## 1. Overview and Problem Statement

### 1.1 Overview

RAIN watches the HTTP APIs a team depends on — its own or third-party — and tells the team when
they fail. Owners register endpoints, RAIN checks them on a schedule from a background worker,
classifies each result, opens and resolves incidents automatically, notifies the owner by email or
webhook, and publishes the health of selected services on a public status page.

### 1.2 Problem Statement

Teams that depend on external APIs usually learn about outages from their own users. Existing
monitoring tools are either heavyweight or opaque about how "up" is computed. RAIN aims to be:

- **Trustworthy** — health, availability and incident rules are explicit, documented and the same
  everywhere (API, UI, status page).
- **Safe** — a monitoring tool sends requests to user-supplied URLs, which makes it an SSRF target.
  RAIN treats outbound requests as a security boundary.
- **Small** — one API, one worker, one database, one web app.

---

## 2. Objectives and Scope

### 2.1 Objectives

1. Detect failing and slow endpoints within one check interval.
2. Turn repeated failures into a single incident per outage, resolved automatically on recovery.
3. Notify owners reliably (at-least-once, de-duplicable) without blocking the monitoring loop.
4. Report availability and latency with defensible definitions.
5. Let owners share service health publicly without exposing private configuration.

### 2.2 In Scope (V1)

| Area          | Included                                                                       |
| ------------- | ------------------------------------------------------------------------------ |
| Accounts      | Email/password sign-up, sign-in, password reset (Supabase Auth)                |
| Monitors      | CRUD, pause/resume, encrypted request headers and bodies, Check Now            |
| Monitoring    | Scheduled checks by a horizontally scalable worker                             |
| Health        | HEALTHY / DEGRADED / DOWN / UNKNOWN with consecutive-result thresholds         |
| Incidents     | Automatic open/resolve, acknowledge, edit title/description/severity, timeline |
| Analytics     | Availability, failure reasons, latency percentiles, time series (24h/7d/30d)   |
| Notifications | Email (Resend) and signed webhooks for incident opened/resolved, retries       |
| Status pages  | Public pages per owner with chosen monitors, display names and 30-day history  |

### 2.3 Out of Scope (V1)

Teams and shared workspaces, billing, custom status-page domains, Slack/SMS/PagerDuty channels,
multi-region checking, keyword/body assertions, maintenance windows, and status-page subscriptions.

---

## 3. Target Users

| User                   | Need                                                       |
| ---------------------- | ---------------------------------------------------------- |
| Developer / API owner  | Know quickly when an endpoint they own or depend on breaks |
| On-call engineer       | One incident per outage, acknowledgement, a clear timeline |
| Engineering lead       | Availability and latency trends; which monitors fail most  |
| Customers of the owner | A public, read-only status page with no sign-in            |

---

## 4. Functional Requirements

### 4.1 Accounts and Authentication (FR-1)

| ID     | Requirement                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------- |
| FR-1.1 | Users register, sign in, sign out and reset passwords through Supabase Auth.                      |
| FR-1.2 | Every private API request carries a Supabase access token, verified by the API (JWKS or HS256).   |
| FR-1.3 | A profile row is created for each user on first use (account view or first monitor/page created). |
| FR-1.4 | Every resource is owned by one user; a user can never read or change another user's data (404).   |

### 4.2 Monitor Management (FR-2)

| ID      | Requirement                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| FR-2.1  | Create a monitor with name, description, URL, method, expected status, timeout, latency threshold and interval. |
| FR-2.2  | Limits: interval 60 s – 24 h (default 5 min); timeout 1–30 s (default 10 s); latency threshold ≤ timeout.       |
| FR-2.3  | Up to 20 request headers per monitor; values are encrypted at rest and never returned by the API.               |
| FR-2.4  | POST/PUT/PATCH monitors require explicit consent to send mutating requests; bodies up to 32 KB, encrypted.      |
| FR-2.5  | URLs: http/https only, ports 80/443 only, no private/loopback/metadata IPs, no local hostnames, no credentials. |
| FR-2.6  | Changing a monitor's origin (scheme/host/port) requires confirmation and removes stored credentials.            |
| FR-2.7  | List monitors with search, status and active/paused filters and cursor pagination; per-user quota (default 25). |
| FR-2.8  | Pause and resume; paused monitors are not checked and keep their last status.                                   |
| FR-2.9  | **Check Now**: request an immediate check (10 s cooldown per monitor; 20/min per user, 30/min per IP).          |
| FR-2.10 | Show check history (time, source, outcome, status code, latency, failure reason).                               |

### 4.3 Monitoring Engine (FR-3)

| ID     | Requirement                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-3.1 | A background worker checks every enabled monitor when due, and runs requested manual checks first.                                                                                               |
| FR-3.2 | Several workers may run at once; each monitor is checked by one worker at a time (leases).                                                                                                       |
| FR-3.3 | A check that a crashed worker started is retried after its lease expires and is recorded at most once.                                                                                           |
| FR-3.4 | Outbound requests use the SSRF-safe transport: DNS validated at connect time, IP pinned, TLS verified, no redirects followed.                                                                    |
| FR-3.5 | Each check is classified **SUCCESS** (expected status within the latency threshold), **DEGRADED** (expected status, slow) or **FAILURE** (unexpected status, timeout, connection/DNS/TLS error). |
| FR-3.6 | Checks RAIN refuses to send (blocked destination, configuration error) are recorded but do not change health.                                                                                    |

### 4.4 Health Classification (FR-4)

| ID     | Requirement                                                                                  |
| ------ | -------------------------------------------------------------------------------------------- |
| FR-4.1 | New monitors are **UNKNOWN** until their first check.                                        |
| FR-4.2 | One failure makes a monitor **DEGRADED**; **2 consecutive failures** make it **DOWN**.       |
| FR-4.3 | A DOWN monitor needs **2 consecutive passing checks** to recover; until then it is DEGRADED. |
| FR-4.4 | Slow checks (DEGRADED outcome) mark a monitor DEGRADED but count as passing for recovery.    |

### 4.5 Incident Management (FR-5)

| ID     | Requirement                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| FR-5.1 | An incident opens automatically when a check leaves a monitor DOWN and it has no active incident.                   |
| FR-5.2 | At most one active (OPEN or ACKNOWLEDGED) incident per monitor.                                                     |
| FR-5.3 | An incident resolves automatically when the recovery threshold is met.                                              |
| FR-5.4 | Owners can acknowledge incidents and edit title, description and severity (CRITICAL/HIGH/MEDIUM/LOW; default HIGH). |
| FR-5.5 | Every change is recorded in an append-only timeline (opened, acknowledged, updated, resolved).                      |
| FR-5.6 | List incidents with status/severity/monitor filters and counts; incident detail shows duration and timeline.        |

### 4.6 Analytics (FR-6)

| ID     | Requirement                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| FR-6.1 | Overview and per-monitor analytics for 24 hours, 7 days and 30 days.                                                 |
| FR-6.2 | Availability = successful checks ÷ eligible checks, where refused checks are not eligible. Never rounded up to 100%. |
| FR-6.3 | Latency: average, min, max, P50, P95, P99 (from checks that received a response).                                    |
| FR-6.4 | Time series per bucket (hour or day): availability, average and P95 latency, check counts, incidents.                |
| FR-6.5 | Failure reasons breakdown; monitors with the most failures and the most incidents.                                   |
| FR-6.6 | "No data" is shown as such, never as 0% or 100%.                                                                     |

### 4.7 Notifications (FR-7)

| ID     | Requirement                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| FR-7.1 | Per monitor, enable email (to the account address) and/or a webhook URL with an optional auth header.        |
| FR-7.2 | Notify on incident opened and incident resolved.                                                             |
| FR-7.3 | Webhooks are signed (HMAC-SHA256, `v1=` scheme over `timestamp.body`); the signing secret is shown once.     |
| FR-7.4 | Deliveries are queued in the same transaction as the incident (no lost or phantom notifications).            |
| FR-7.5 | Failed deliveries retry with exponential backoff (30 s doubling, capped at 6 h, jittered), up to 8 attempts. |
| FR-7.6 | Delivery history with per-attempt outcome, HTTP status and error; manual retry of failed deliveries.         |
| FR-7.7 | Without a configured email provider, email deliveries are recorded as failed — never reported as sent.       |

### 4.8 Public Status Pages (FR-8)

| ID     | Requirement                                                                                   |
| ------ | --------------------------------------------------------------------------------------------- |
| FR-8.1 | Up to 10 pages per owner, each with title, description and a unique slug (`/status/<slug>`).  |
| FR-8.2 | Add up to 50 of the owner's own monitors with public display names; reorder; remove.          |
| FR-8.3 | Pages are drafts until published; owners can preview drafts and unpublish.                    |
| FR-8.4 | Public view: overall status, per-service status, 30-day daily availability, recent incidents. |
| FR-8.5 | The public view exposes no IDs, URLs, private monitor names or internal incident text.        |
| FR-8.6 | Public endpoint is unauthenticated, rate limited (60/min per IP), `no-store` and `noindex`.   |

### 4.9 Web Application (FR-9)

| ID     | Requirement                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-9.1 | Screens: Overview dashboard, Monitors, Monitor detail (overview, analytics, notifications, history, configuration), Incidents, Analytics, Notifications, Status pages, public status page. |
| FR-9.2 | Responsive from 375 px phones to wide desktops; keyboard accessible; reduced-motion respected.                                                                                             |
| FR-9.3 | Loading skeletons, empty states and error states with retry and request ID on every data view.                                                                                             |

---

## 5. Non-Functional Requirements

### 5.1 Performance

- Each worker process runs up to 25 concurrent checks (configurable 1–500) and polls every second when idle.
- Analytics are computed in SQL (`percentile_cont`, `date_bin`) over indexed check history.
- API responses for list views are paginated (cursor-based for monitors and incidents).

### 5.2 Reliability

- PostgreSQL is the only durable state; workers are stateless and can crash at any point.
- Leases make claims safe across workers; attempt IDs make check recording idempotent.
- Notification delivery is at-least-once with a stable delivery ID for receiver de-duplication.
- API and worker shut down gracefully on SIGTERM/SIGINT.

### 5.3 Data Integrity

- Check result, health update, incident change and notification queueing commit in one transaction.
- Database constraints enforce valid states (checks, unique active incident, same-owner status-page monitors, append-only timeline).

### 5.4 Security

- Supabase JWT verification on every private request; per-owner scoping in every query.
- Row Level Security enabled with no policies on all application tables (only the API's role reads them).
- AES-256-GCM encryption for header values, request bodies, webhook secrets and webhook auth headers, with key rotation.
- SSRF defence in depth (registration, executor, transport, worker).
- Helmet security headers, CORS allow-list, body size limits, rate limits, log redaction of secrets.
- Database errors are logged without SQL parameters; public text rejects bidirectional control characters.

### 5.5 Usability and Maintainability

- One shared Zod contract package used by API and web app.
- TypeScript strict mode, ESLint, Prettier; unit, component and integration test suites.

---

## 6. Main Use Cases

### UC-1: Register a monitor

1. The owner opens **Monitors → Add monitor** and fills in name, URL, method and timing.
2. The web app validates the form with the shared schema; the API validates again, including URL safety.
3. The API stores the monitor (secrets encrypted) with `next_check_at = now`.
4. The monitor appears as **UNKNOWN** until the worker's first check.

### UC-2: Scheduled check

1. A worker claims due monitors with a lease (`FOR UPDATE SKIP LOCKED`).
2. It sends the request through the SSRF-safe transport with no transaction open.
3. In one short transaction it records the check, updates health and schedules the next check.

### UC-3: Outage and recovery

1. Two consecutive failures make the monitor DOWN; an incident opens and notifications are queued.
2. The dispatcher delivers email/webhook notifications, retrying on temporary failures.
3. Two consecutive passing checks resolve the incident and queue "resolved" notifications.

### UC-4: Investigate

1. The owner opens the incident (timeline, trigger check, duration) and acknowledges it.
2. Analytics show availability, latency percentiles and failure reasons for the period.

### UC-5: Publish a status page

1. The owner creates a page, adds monitors with public names and previews it.
2. Publishing makes `/status/<slug>` available to anyone; unpublishing removes it.

---

## 7. Constraints, Status and Roadmap

### 7.1 Constraints

- Node.js 26, Supabase (PostgreSQL + Auth), Resend for email.
- Monitors can only target public addresses on ports 80/443.
- The worker needs direct outbound internet access (no HTTP proxy; DNS pinning relies on direct connections).

### 7.2 Current Status

| Area                                  | Status                                              |
| ------------------------------------- | --------------------------------------------------- |
| All V1 features                       | Implemented, unit/component tested (977 tests)      |
| PostgreSQL migrations and integration | Suites written; not yet run against a real database |
| End-to-end against Supabase           | Not yet verified                                    |
| Real email delivery                   | Not yet verified (needs a Resend key)               |
| Hosted deployment                     | Not deployed                                        |

### 7.3 Roadmap (post-V1)

Teams and roles, maintenance windows, status-page subscriptions and custom domains, Slack and
PagerDuty channels, response-body assertions, multi-region checks.
