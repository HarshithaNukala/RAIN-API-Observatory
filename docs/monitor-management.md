# Monitor management

A **monitor** is the configuration of one API endpoint RAIN will check: where to send the request,
how, how often, and what counts as healthy. This module stores and manages that configuration.
It does **not** run checks: the monitoring engine is a later phase, so every monitor's status
stays `UNKNOWN` until a real check records one.

Contracts live in `packages/shared/src/monitor*.ts` and are used by both the API and the web app.

## Endpoints

All endpoints require `Authorization: Bearer <Supabase access token>` and only ever touch the
caller's own monitors. A monitor that doesn't exist and one that belongs to someone else both get
the same `404 MONITOR_NOT_FOUND`, so IDs can't be probed. Every `/api` response is
`Cache-Control: no-store`.

| Method & path                        | Body                                                                                                   | Success                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `POST /api/v1/monitors`              | `CreateMonitor` (below)                                                                                | `201 { data: Monitor }` + `Location`                                        |
| `GET /api/v1/monitors`               | query: `search`, `state` (`all`\|`enabled`\|`paused`), `status`, `limit` (1–100, default 25), `cursor` | `200 { data: { items, nextCursor, total, quota } }`                         |
| `GET /api/v1/monitors/:id`           | —                                                                                                      | `200 { data: Monitor }`                                                     |
| `PATCH /api/v1/monitors/:id`         | `UpdateMonitor` (below)                                                                                | `200 { data: Monitor, meta: { originChanged, savedConfigurationCleared } }` |
| `PATCH /api/v1/monitors/:id/headers` | `{ upsert?: [{ name, value }], remove?: [name] }`                                                      | `200 { data: Monitor }`                                                     |
| `POST /api/v1/monitors/:id/pause`    | —                                                                                                      | `200 { data: Monitor }`                                                     |
| `POST /api/v1/monitors/:id/resume`   | —                                                                                                      | `200 { data: Monitor }`                                                     |
| `DELETE /api/v1/monitors/:id`        | —                                                                                                      | `204`                                                                       |

### Fields

| Field                   | Rules                                                                                                                                                                             | Default  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `name`                  | 1–100 chars, trimmed                                                                                                                                                              | required |
| `description`           | ≤ 500 chars; empty → `null`                                                                                                                                                       | `null`   |
| `url`                   | see [URL rules](#url-rules)                                                                                                                                                       | required |
| `method`                | `GET` `HEAD` `OPTIONS` `POST` `PUT` `PATCH`                                                                                                                                       | `GET`    |
| `expectedStatusCode`    | 100–599                                                                                                                                                                           | 200      |
| `timeoutMs`             | 1000–30000                                                                                                                                                                        | 10000    |
| `latencyThresholdMs`    | 1–30000, ≤ `timeoutMs`                                                                                                                                                            | 2000     |
| `checkIntervalSeconds`  | 60–86400                                                                                                                                                                          | 300      |
| `requestBody`           | ≤ 64 KB UTF-8; POST/PUT/PATCH only; encrypted at rest                                                                                                                             | `null`   |
| `bodyContentType`       | media type; only with a body; `application/json` when omitted                                                                                                                     | `null`   |
| `headers` (create only) | ≤ 20; RFC 9110 names; no CR/LF/NUL in values; ≤ 4096 chars each; ≤ 32 KB total; connection-level names (`Host`, `Content-Length`, `Transfer-Encoding`, `Content-Type`, …) refused | `[]`     |

`Monitor` responses contain everything above except header **values**: headers appear only as
`{ name, configured: true, updatedAt }`. The list endpoint never includes the request body or
headers. `currentStatus` is the stored health (`UNKNOWN` `HEALTHY` `DEGRADED` `DOWN`); "paused"
is `enabled: false` and is not a status. `nextCheckAt` is `null` while paused.

### Updating settings

`PATCH /api/v1/monitors/:id` is a partial update. Omitted fields are unchanged. For
`requestBody`: omitted = keep, `null` = remove, string = replace. The merged result is validated
as a whole (for example, switching to `GET` while a body is saved is refused). A `headers` field
is rejected: credentials are never changed by omission.

### Headers

Header values are encrypted (AES-256-GCM, per-row context) and **write-only**. They change only
through `PATCH …/headers`:

- `upsert` creates a header or replaces the value of an existing one (names match
  case-insensitively).
- `remove` deletes the named headers; removing an absent header is not an error.
- A header named in neither list is left exactly as it is.
- Naming the same header in both lists is a validation error.
- The 20-header and 32 KB limits apply to the monitor's resulting header set, counting headers
  already stored.

### Origin changes

The **origin** is the scheme, normalised hostname and effective port of the URL; the path and
query are not part of it (`monitorOrigin` in `packages/shared/src/monitor-url.ts`).

- Changing only the path or query keeps the saved headers and request body.
- Changing the origin while headers or a body are saved returns
  **`409 MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED`** and changes nothing. The message says
  saved headers and body would be removed; it never says which secrets exist or what they are.
- Repeating the request with **`confirmOriginChange: true`** removes, in one transaction, all
  saved headers, the request body and the body content type, then applies the change. If any
  step fails, the whole previous configuration is kept. The response's
  `meta.savedConfigurationCleared` is `true`.
- A `requestBody` sent in the same confirmed request is treated as the new body for the new
  destination. Headers for the new destination are added afterwards with `PATCH …/headers`.
- If nothing secret is saved, an origin change needs no confirmation
  (`meta: { originChanged: true, savedConfigurationCleared: false }`).

### URL rules

`http://` or `https://`; public hostname or public IP literal; no user-info; no credential-like
query parameters; **only ports 80 (http) and 443 (https)**, explicit or implicit. A request whose
only problem is a non-standard port gets the top-level code **`UNSUPPORTED_PORT`**; the field issue
also carries `code: "UNSUPPORTED_PORT"`. Custom ports may come later through an
administrator-controlled allowlist. Full SSRF protection (DNS resolution and address pinning at
connection time) is a requirement for the monitoring engine: see
[security/monitor-network-security.md](security/monitor-network-security.md).

### Pause, resume, delete, quota

- **Pause** sets `enabled = false` and keeps the configuration, stored status and counters.
- **Resume** sets `enabled = true` and schedules a check for now; it records no result.
- **Delete** is permanent and removes the monitor's headers with it.
- Each user may own `MAX_MONITORS_PER_USER` monitors (default 25). Creating one more returns
  `409 MONITOR_LIMIT_REACHED`.

### Errors

Every error is `{ error: { code, message, requestId, details? } }`. Validation errors
(`VALIDATION_ERROR`, or `UNSUPPORTED_PORT` as above) carry `details: [{ path, message, code? }]`
addressed to request fields (`url`, `headers.0.value`, `upsert.1.name`, …).

| Status | Code                                          | When                                            |
| ------ | --------------------------------------------- | ----------------------------------------------- |
| 400    | `VALIDATION_ERROR`                            | Invalid fields or combination                   |
| 400    | `UNSUPPORTED_PORT`                            | The only problem is a non-standard port         |
| 401    | `UNAUTHENTICATED` / `TOKEN_EXPIRED`           | Missing, invalid or expired token               |
| 404    | `MONITOR_NOT_FOUND`                           | Unknown, malformed or someone else's monitor ID |
| 409    | `MONITOR_LIMIT_REACHED`                       | Quota used up                                   |
| 409    | `MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED` | Origin change without confirmation              |
| 413    | `PAYLOAD_TOO_LARGE`                           | Body over 256 kB                                |
| 429    | `RATE_LIMITED`                                | Over 120 requests/min                           |

## Web app

| Route                    | Screen                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/app/monitors`          | Registry: search (debounced), status and active/paused filters (kept in the URL), cursor pagination, quota, row actions (view, edit, pause/resume, delete), loading, empty, no-match and error states with retry                                               |
| `/app/monitors/new`      | Create form: basic details, endpoint, performance, request body (size guidance), authentication headers (add/remove rows, show/hide values)                                                                                                                    |
| `/app/monitors/:id`      | Details: Overview (stored status, last/next check, a note that history arrives with the monitoring engine) and Configuration (settings, header names marked "Credential configured", body presence and size only)                                              |
| `/app/monitors/:id/edit` | Same form, prefilled with non-secret settings. Saved headers show "Credential configured" with an empty field: empty means keep, typing replaces, **Remove** deletes. Changing to a different origin while secrets are saved opens a confirmation dialog first |

The form validates with the same shared schemas as the API before sending, shows errors beside
each field, and moves focus to the first problem. The backend stays authoritative: if it still
answers `409 MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED`, the confirmation dialog opens.
Cancelling the dialog sends nothing and restores the saved URL. Header values exist only in
component state while typing: they are never written to `localStorage` or any other storage.

Data comes from TanStack Query with keys `['monitors','list',params]` and
`['monitors','detail',id]`. Every mutation stores the returned monitor and invalidates the lists.
Deleting removes the detail entry.

## Development harness

`apps/web/harness.html` (Vite dev server only, never in `npm run build`) renders the real routes
against an in-memory fake API with a placeholder session, so the signed-in screens can be
inspected without Supabase. Every screen carries a banner saying so. It is not a test of the real
backend.
