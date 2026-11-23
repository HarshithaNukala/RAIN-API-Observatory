# Phase 7: Public status pages completion report

## Summary

**Done and verified with no database:**

- Owners can create status pages, choose and order their monitors under public names, preview, publish and unpublish, copy the link, and delete.
- Visitors open `/status/<slug>` without signing in. They see an overall status, per-service health, 30-day check-based availability, recent incidents and a last-updated time.
- All local checks pass: typecheck, lint, format, 969 tests (twice), build.
- The built API serves the public route without auth and keeps management behind it.
- The public page and the editor were checked in a real browser (dev harness, fake data) at phone and desktop widths.

**Blocked:** the PostgreSQL integration suites (Phases 3–7). There's no Docker and no disposable database.

Nothing is committed or pushed, and Phase 8 has not been started.

## Features implemented

- **Management:** create (generated or chosen unique slug), list with quota, edit title, description and slug, publish and unpublish, delete.
- **Services:** add monitors (owner-only, no duplicates, 50 per page), public display names, reorder, remove.
- **Preview:** for the owner, of draft or published pages.
- **Public endpoint and page:**
  - overall status, with paused monitors shown and excluded;
  - service status and last check, 30 days of daily availability (no-data days stay empty);
  - generated, safe incident history;
  - last updated time;
  - responsive, with no app shell and no sign-in.
- **Navigation:** a **Status pages** entry; editor at `/app/status-pages/:id`; preview at `/app/status-pages/:id/preview`; public page at `/status/:slug`.

## Database migration

`0007_status_pages` (generated, plus a hand-written trigger; 0000–0006 unchanged):

- **`status_pages`**:
  - unique slug, with a format CHECK;
  - published and `published_at` consistency;
  - title and description checks;
  - an owner and created-at index.
- **`status_page_monitors`**:
  - primary key `(page, monitor)`, which prevents duplicates;
  - position and display-name checks, plus a position index;
  - cascades from pages and monitors.
- **Trigger `status_page_monitors_same_owner`:** a monitor can only be attached to a page with the same owner, enforced in the database.
- **RLS** is enabled on both tables, as on every other table.

## API endpoints

**Authenticated and owner-scoped (`/api/v1`):**

- `POST/GET /status-pages`
- `GET/PATCH/DELETE /status-pages/:id`
- `POST /status-pages/:id/publish|unpublish`
- `GET /status-pages/:id/preview`
- `POST /status-pages/:id/monitors`
- `PATCH/DELETE /status-pages/:id/monitors/:monitorId`
- `PUT /status-pages/:id/monitors/order`

**Public:** `GET /api/v1/public/status-pages/:slug`.

- No auth; 60 requests/min per IP.
- `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- 404 for unpublished, unknown or malformed slugs.

All inputs are validated with the shared Zod schemas.

## Public page functionality

**Overall status:**

- DOWN if any active service is DOWN;
- otherwise DEGRADED if any is DEGRADED;
- otherwise UNKNOWN if no active service has a known status;
- otherwise HEALTHY.

**Paused monitors** are shown as Paused and excluded.

**Availability:**

- Check-based, with RAIN refusals excluded.
- Days without data are shown as "no data" (grey), never as up.

**Incidents:**

- Only the page's monitors; open ones, or started in the last 30 days; at most 20.
- Status shown as Investigating, Identified or Resolved, with severity, start and resolution times.
- The summary is generated.

## Security protections

- **Owner checks** on every management statement. Monitor ownership is checked in the service, by the database trigger, and again on public reads.
- **Generated public view:**
  - no database IDs (keys are `s1` and `i1`);
  - no private monitor names, URLs, headers, bodies, credentials or owner data;
  - internal incident titles, descriptions and timelines are never used.
  - Tests scan the public JSON for UUIDs and known secrets.
- **Plain-text custom content** rendered as text, with no HTML or scripts. Control characters are rejected and objects are strict.
- **Public endpoint:** published only, rate-limited, never cached (so unpublishing is immediate), not indexed, and generic errors only.
- **Bounded queries:** unique-slug lookup; at most 50 services; per-day counts grouped in SQL; at most 20 incidents; all through existing indexes.
- **Nothing weakened:** authentication, SSRF protection and the existing APIs are unchanged.

## Tests and actual results

| Command                    | Result                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`        | PASS (0 errors)                                                                                                                                                                                        |
| `npm run lint`             | PASS                                                                                                                                                                                                   |
| `npm run format:check`     | PASS                                                                                                                                                                                                   |
| `npm run test`             | PASS: 969 tests in 41 files, two full runs (46 new: server 35, web 11)                                                                                                                                 |
| `npm run test:integration` | **BLOCKED** (see below)                                                                                                                                                                                |
| `npm run build`            | PASS                                                                                                                                                                                                   |
| `git diff --check`         | clean; no dependency changes this phase                                                                                                                                                                |
| Built API                  | Public route without a token: malformed slug gives 404 with `no-store` and `noindex`; valid slug gives a generic 500 (no database running; no internals leaked). Management without a token gives 401. |
| Browser (harness)          | Public page at 375 px: no overflow, correct statuses (paused shown), bars and incidents. Editor at 1280 px: no overflow, URL and controls present.                                                     |

## Outstanding blockers

- **PostgreSQL integration is BLOCKED.**
  - Docker isn't installed, there's no local PostgreSQL, and `TEST_DATABASE_URL` is unset.
  - Written but not run: `tests/integration/status-pages.test.ts`, covering the slug CHECK and uniqueness, the trigger, the primary key, cascades, the public SQL through HTTP with and without a token, and isolation.
  - Also not run: the earlier suites for Phases 3–6.
  - Migrations 0004–0007, the same-owner trigger and the `date_trunc` daily grouping have never run on a real database.
- **Not tested in a real browser against the real API with Supabase sign-in.**

## Known limitations

- **Not in scope:** custom domains, team collaboration and subscriptions.
- **Incident text** is always generated; there's no per-incident public text.
- **The editor's monitor picker** shows the first 100 monitors.
- **No CDN caching**, by design. Traffic spikes rely on rate limiting and bounded queries.
- **The public page** needs the web app's normal configuration to load.
- **Earlier phases:** their limitations still apply.

## Git branch and working tree

- **Branch:** `feat/monitoring-foundation`, HEAD `b4869a8`.
- **Uncommitted:** Phases 3–7 are all uncommitted, and nothing is pushed.
- **Legacy Java repository:** no changes.
- **Old migrations:** untouched.
- **No new dependencies.**
