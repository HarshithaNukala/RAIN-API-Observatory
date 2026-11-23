# Public status pages

Owners publish pages at `/status/<slug>` showing selected monitors under public names:

- current health and an overall status;
- 30 days of check-based availability;
- recent incidents.

Visitors don't sign in. Only explicitly selected, generated, safe information is ever shown.

## Publication workflow

1. **Create** a page: title, optional description, and an optional address (slug). A slug is generated from the title if omitted, with a random suffix if taken. New pages are **drafts**.
2. **Add services:** choose your monitors. Each gets a **public name** (it defaults to the monitor name, so rename internal names) and a position. Reorder with ↑/↓.
3. **Preview** at `/app/status-pages/:id/preview`. The owner sees exactly what visitors will see, draft or not.
4. **Publish.** `/status/<slug>` works for anyone, with no sign-in.
5. **Unpublish or delete.** The public endpoint answers 404 from the next request (nothing is cached). Changing the slug breaks the old address immediately.

## Data model (migration `0007_status_pages`)

### `status_pages`

| Column                     | Notes                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid                                                                                                          |
| `owner_id`                 | FK → profiles, ON DELETE CASCADE                                                                              |
| `title`                    | varchar(120), not blank                                                                                       |
| `description`              | text ≤ 1000, nullable; plain text                                                                             |
| `slug`                     | varchar(64), **unique** (`status_pages_slug_uq`); CHECK `^[a-z0-9](?:[a-z0-9]\|-(?=[a-z0-9])){1,62}[a-z0-9]$` |
| `published`                | boolean, default false                                                                                        |
| `published_at`             | set when published; CHECK `published → published_at IS NOT NULL`                                              |
| `created_at`, `updated_at` |                                                                                                               |

### `status_page_monitors`

| Column           | Notes                                                    |
| ---------------- | -------------------------------------------------------- |
| `status_page_id` | FK → status_pages, ON DELETE CASCADE                     |
| `monitor_id`     | FK → monitors, ON DELETE CASCADE                         |
| `display_name`   | varchar(100), not blank: the public name                 |
| `position`       | int ≥ 0; rewritten as 0..n−1 on every reorder or removal |
| `created_at`     |                                                          |

**Constraints and indexes:**

- **Primary key** `(status_page_id, monitor_id)`: a monitor appears at most once per page.
- **Trigger** `status_page_monitors_same_owner`: rejects any row whose monitor's owner differs from the page's owner, whoever is connected (SQLSTATE 23503).
- **Indexes:** `(status_page_id, position)` for ordering, plus `monitor_id`.
- **Row-level security:** enabled with no policies on both tables, like every other table.
- **Earlier migrations (0000–0006)** are unchanged.

**Limits:** 10 pages per owner, 50 monitors per page. The slugs `app`, `api`, `admin`, `login`, `status`, `www` and `new` are reserved.

## API

### Owner management

Under `/api/v1`, with a bearer token, owner-scoped in SQL. Another user's page returns 404 `STATUS_PAGE_NOT_FOUND`, and another user's monitor returns 404 `MONITOR_NOT_FOUND`.

| Method & path                                  | Purpose                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `POST /status-pages`                           | Create (`title`, `description?`, `slug?`) → 201                 |
| `GET /status-pages`                            | List with monitor counts and quota                              |
| `GET /status-pages/:id`                        | Configuration, including monitors with private names and health |
| `PATCH /status-pages/:id`                      | Edit `title`, `description`, `slug`                             |
| `POST /status-pages/:id/publish`, `/unpublish` | Change visibility                                               |
| `DELETE /status-pages/:id`                     | Delete (selections cascade) → 204                               |
| `GET /status-pages/:id/preview`                | The public view, whether published or not                       |
| `POST /status-pages/:id/monitors`              | Add (`monitorId`, `displayName?`) → 201                         |
| `PATCH /status-pages/:id/monitors/:monitorId`  | Rename (`displayName`)                                          |
| `DELETE /status-pages/:id/monitors/:monitorId` | Remove; positions are compacted                                 |
| `PUT /status-pages/:id/monitors/order`         | Reorder (`monitorIds`: exactly the page's monitors)             |

**Errors:**

- 409 `STATUS_PAGE_SLUG_TAKEN`, `STATUS_PAGE_LIMIT_REACHED`, `STATUS_PAGE_MONITOR_EXISTS`, `STATUS_PAGE_MONITOR_LIMIT_REACHED`.
- 400 `VALIDATION_ERROR`, from the shared Zod schemas: strict objects, single-line titles and names, no control characters, and the slug format.

### Public

`GET /api/v1/public/status-pages/:slug`:

- **No authentication.**
- Mounted before the authenticated router, with its own rate limit: 60 requests/min per client IP.
- Returns 200 with the public view for published pages.
- Returns 404 `STATUS_PAGE_NOT_FOUND` for unpublished, unknown or malformed slugs. All of these look the same.
- Headers: `Cache-Control: no-store` (unpublishing is immediate and private data is never cached) and `X-Robots-Tag: noindex`.

## What the public sees

```json
{
  "title": "Acme status",
  "description": "Live status of Acme services.",
  "overallStatus": "DEGRADED",
  "services": [
    {
      "key": "s1",
      "name": "Payments API",
      "status": "DEGRADED",
      "lastCheckedAt": "2026-11-19T10:25:00.000Z",
      "availabilityPercent": 99.86,
      "days": [{ "date": "2026-10-21", "availabilityPercent": null }, "…"]
    }
  ],
  "incidents": [
    {
      "key": "i1",
      "title": "Payments API disruption",
      "serviceName": "Payments API",
      "status": "INVESTIGATING",
      "severity": "HIGH",
      "startedAt": "2026-11-19T09:10:00.000Z",
      "resolvedAt": null,
      "summary": "Payments API is unavailable or failing checks. We are investigating."
    }
  ],
  "historyDays": 30,
  "generatedAt": "2026-11-19T10:30:00.000Z"
}
```

- **Overall status:**

  | Status   | When                                                                                |
  | -------- | ----------------------------------------------------------------------------------- |
  | DOWN     | any active service is DOWN                                                          |
  | DEGRADED | none is DOWN, but one is DEGRADED                                                   |
  | UNKNOWN  | no active service has a known status (no services, none checked yet, or all paused) |
  | HEALTHY  | otherwise                                                                           |

  Paused monitors are shown as **PAUSED** and excluded.

- **Availability:**
  - check-based, as in analytics: SSRF and configuration refusals are excluded;
  - per UTC day over 30 days, plus a 30-day total;
  - days without counted checks are `null` ("no data", grey bars), never invented as up or down.
- **Incidents:**
  - only those of monitors on this page, started in the last 30 days or still open;
  - newest first, at most 20;
  - status mapped to INVESTIGATING (open), IDENTIFIED (acknowledged) or RESOLVED.

**Never exposed:**

- Database IDs. `key` values are positions such as `s1` and `i1`.
- Private monitor names.
- Monitor URLs, headers, request bodies and credentials.
- Owner identity.
- Internal incident titles and descriptions, and timeline events.

Incident titles and summaries are **generated** from the public service name, status and timestamps. The stored incident text can contain internal names, hosts or error details, so it is never used. Tests check that no UUID, internal name, URL fragment or error detail appears in the public JSON.

## Security

- **Owner checks:**
  - every management statement filters by `owner_id`;
  - attaching a monitor requires that the caller owns it;
  - the database trigger enforces the same rule;
  - public reads re-join on matching owners.
- **Input:**
  - shared Zod schemas validate everything; objects are strict, so system fields can't be set;
  - titles, descriptions and public names are **plain text**, rendered by React as text, never as HTML. There's no markdown and no custom scripts or styles. A `<script>` typed into a description is shown literally.
- **Public endpoint:**
  - published pages only;
  - rate-limited, uncached and not indexed;
  - errors are generic (`INTERNAL_ERROR` without details).
- **Bounded queries:**
  - one page lookup by unique slug;
  - at most 50 services;
  - daily counts grouped in SQL (≤ 50 × 30 rows) through `monitor_checks(monitor_id, checked_at)`;
  - at most 20 incidents through the incident indexes.
- **No change to existing protections:** authentication, SSRF protections and the other APIs are unchanged.

## Web app

- **Status pages** (in the main navigation): the list with states and quota, plus create (title and optional address).
- **Editor** (`/app/status-pages/:id`):
  - publish and unpublish;
  - the public URL with **Copy link**, **Open** (when published) and **Preview**;
  - page details;
  - services: add from your monitors, public names, ↑/↓ reorder, remove;
  - delete with confirmation;
  - loading, empty, error and success states.
- **Public page** (`/status/:slug`):
  - responsive layout without the app shell or sign-in;
  - overall banner, service rows with status, 30-day bars, availability and last checked, incident history, last updated;
  - not-found and retry states;
  - refreshes every 60 s.

## Testing

```bash
npm test
```

| Test file                                                  | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/status-pages/status-pages.test.ts`        | Overall status and paused handling; generated incident text; daily availability with no-data days; slug generation; the service (create, unique and generated slugs, quota, editing, monitor ownership, duplicates, ordering, renaming, removal, per-page limit, owner isolation, publish and unpublish, preview, cascades); the public view (selection, status, last checked, availability with exclusions, incident filtering by monitor and window, sensitive-data exclusion with a UUID scan, UNKNOWN cases). |
| `apps/server/src/status-pages/status-page-routes.test.ts`  | Public access without a token, unpublished and malformed slugs → 404, `no-store` and `noindex`, rate limit, management auth, cross-user isolation, validation, the reorder route.                                                                                                                                                                                                                                                                                                                                 |
| `apps/web/src/features/status-pages/status-pages.test.tsx` | The public page signed out (statuses, paused, incidents, plain-text description, no leaks), not-found and retry, management requiring sign-in, create with slug error, list, add, rename, reorder and remove, publish, copy, unpublish and delete, draft preview, error and retry.                                                                                                                                                                                                                                |

```bash
npm run test:integration
```

`tests/integration/status-pages.test.ts` covers slug uniqueness and the format CHECK, the same-owner trigger and the primary key, cascades, the public SQL (daily counts with exclusions, incident filtering) through HTTP with and without a token, and owner isolation. It needs Docker or `TEST_DATABASE_URL`.

## Known limitations

- **Not in scope:** custom domains, team collaboration and subscriptions.
- **Incident text** can't be customised per incident. The public title and summary are always generated.
- **The monitor picker** in the editor lists the first 100 monitors; the default per-user limit is 25.
- **No CDN caching** (`no-store`), by design, so unpublishing is immediate. Heavy traffic relies on the per-IP rate limit and the bounded queries.
- **Missing configuration:** the public page is part of the SPA, so it needs the web app's normal configuration (Supabase variables) to load.
