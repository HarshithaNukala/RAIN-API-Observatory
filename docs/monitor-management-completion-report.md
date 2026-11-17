# Monitor Management — completion report

Branch `feat/monitor-management` · base commit `2f68fae` · 17 November 2026 · **not committed
yet, ready for review**

## 1. Executive summary

This round adds the three security decisions to the committed backend and builds the complete
Monitor Management web UI:

- **Origin-change rule.** Moving a monitor to another scheme, host or port needs explicit
  confirmation, and its saved headers and body are removed in the same transaction.
- **Standard-ports-only policy.** Only 80 and 443 are accepted, enforced by the API, with the
  code `UNSUPPORTED_PORT`.
- **DNS/SSRF requirements.** The monitoring engine's network-security requirements are written
  down.
- **Web UI.** Registry, create, edit, details, pause/resume and delete, plus a new application
  shell.

Every local check passes: typecheck, lint, format, **381 unit and UI tests**, and the production
build.

**Monitor Management is not fully verified end to end.**

- The database integration tests (Docker), real Supabase sign-in, and the UI against the real
  API are **BLOCKED** by missing external prerequisites.
- Browser checks used a development harness with an in-memory fake API, not the real backend.
- DNS/SSRF runtime protection is **BLOCKED** until the monitoring engine exists.

## 2. Initial repository state

| Item              | Value                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Branch            | `feat/monitor-management`                                                                             |
| HEAD              | `2f68fae` (on top of `23d925e`, `1093b96`; `main` = `23d925e`, untouched)                             |
| Working tree      | clean                                                                                                 |
| Backend at start  | Monitor CRUD, encrypted headers/body, URL checks, quota, pagination; no origin rule, any port allowed |
| Frontend at start | No monitor screens; the overview said "Monitor management arrives in the next release"                |

## 3. Git changes (uncommitted)

- **19 tracked files modified** (+1,663 / −111 lines, mostly `package-lock.json` for the new test
  libraries).
- **New files:** the web monitor feature, UI primitives, test support, the harness, two docs and
  12 screenshots.
- No commits, no pushes, `main` untouched, history unchanged, legacy Java repository untouched.

<details><summary>Changed and new files</summary>

**Shared:** `errors.ts` (codes `MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED`, `UNSUPPORTED_PORT`,
`ApiFieldIssueSchema`), `monitor.ts` (`confirmOriginChange`, `MonitorUpdateMeta/ResponseSchema`,
URL issue codes), `monitor-url.ts` (port policy, `monitorOrigin`, `findMonitorUrlIssue`),
`monitor-url.test.ts`.

**Server:** `monitors/monitor-service.ts` (origin rule; `update` returns `{ monitor, meta }`),
`monitors/monitor-routes.ts` (PATCH returns `meta`), `http/error-handler.ts` (issue codes,
`UNSUPPORTED_PORT`), `monitor-routes.test.ts`, `monitor-service.test.ts`.

**Tests:** `tests/integration/monitors.test.ts` (origin-change and port cases).

**Web, modified:** `router.tsx` (`/app/...` routes, `/` → `/app`), `components/app-shell.tsx`
(rewritten), `pages/overview-page.tsx` (real monitor count), `lib/api-client.ts`
(`patchWithMeta`, issue codes), `lib/query-client.ts` (inline-error mutations), `index.css`
(`color-scheme: dark`), `package.json`.

**Web, new:** `features/monitors/{api.ts, format.ts, status-badge.tsx, monitor-actions.tsx,
use-pause-resume.ts, monitors-page.tsx, monitor-form.tsx, monitor-pages.tsx}` and three test files;
`components/page.tsx`; `components/ui/{dialog, alert-dialog, dropdown-menu, tabs, misc}.tsx`;
`test-support/{fake-monitor-api.ts, render-app.tsx, setup.ts, harness.tsx}`; `harness.html`.

**Root and docs:** `vitest.config.ts` (`@` alias, setup file), `README.md`, `docs/testing.md`,
`docs/monitor-management.md`, `docs/security/monitor-network-security.md`,
`docs/screenshots/monitors/*.jpg`, this report.

</details>

**New dev dependencies** (exact versions, all published at least two weeks ago):
`@testing-library/react 16.3.3`, `@testing-library/dom 10.4.2`,
`@testing-library/user-event 14.6.8`, `@testing-library/jest-dom 7.0.1`, `jsdom 30.1.3`.
No runtime dependencies were added. The previously unused Radix packages (dialog, alert-dialog,
dropdown-menu, tabs) are now used.

## 4. Backend implementation

- **Origin rule** (`monitor-service.ts` `update`), inside the existing row-locked transaction:
  1. Compute whether the origin changes.
  2. If headers or a body are saved and `confirmOriginChange !== true`, return 409 before any
     write.
  3. If confirmed, delete the header rows, clear the body's ciphertext, IV, tag and key version
     and the content type, then apply the patch.
  4. Return `meta { originChanged, savedConfigurationCleared }`.
- **Port policy** (`monitor-url.ts`):
  - The effective port comes from the WHATWG URL parser, so an implicit or explicit default port
    is the same thing.
  - `DEFAULT_MONITOR_PORT_POLICY = { http: [80], https: [443] }` is a parameter, ready for a future
    administrator allowlist. No request field can change it.
  - The check is enforced by the shared schema the API uses on every create and URL update.
- **Error contract:**
  - Zod issues carry an optional machine `code`.
  - A request whose only problem is the port gets the top-level `400 UNSUPPORTED_PORT`.
  - Mixed problems stay `VALIDATION_ERROR`, with the port issue still tagged.
- **Owner isolation, pagination, filtering, pause/resume and delete:** unchanged from `2f68fae`
  (reviewed earlier). The new service tests exercise them through an in-memory repository.

## 5. Security decisions

| Decision                     | Implementation                                                                                                          | Verification                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Credentials on origin change | 409 → explicit confirm → transactional removal; generic message, no secret disclosure                                   | Service unit tests (13 new), route tests, UI tests; integration tests written, BLOCKED |
| Standard ports only          | Shared schema + API; `UNSUPPORTED_PORT`; extensible policy                                                              | 28 new shared tests, 4 route tests, UI test; integration case written, BLOCKED         |
| DNS/SSRF at connection time  | Documented as 14 mandatory executor requirements in `docs/security/monitor-network-security.md`; no DNS lookups on save | BLOCKED until the monitoring engine exists                                             |

## 6. Database changes

None. The origin rule uses the existing `monitors` and `monitor_headers` tables and their
cascading foreign keys, so no migration is needed. Migration `0001_monitor_management.sql` is
unchanged and still **has never been applied to a real database**.

## 7. Frontend pages

| Route                    | Delivered                                                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                    | Sidebar from 1024px, slide-in navigation sheet below; profile menu with sign-out; breadcrumbs; toasts; only working links (Overview, Monitors); returns to the top of the page on navigation                                                               |
| `/app`                   | Overview with the real monitor count from the API (no invented health data)                                                                                                                                                                                |
| `/app/monitors`          | Search (debounced), status filter, active/paused filter (in the URL), cursor pagination with range, quota, Add monitor (disabled at quota), row actions, skeleton, empty / no-match / error + retry; tablet and phone layouts without horizontal scrolling |
| `/app/monitors/new`      | Sectioned form, shared-schema validation beside each field, focus on the first error, size guidance, header rows with show/hide, duplicate-submit protection                                                                                               |
| `/app/monitors/:id/edit` | Same form, prefilled with non-secret settings; "Credential configured" with empty = keep, type = replace, explicit Remove/Undo; origin-change dialog (cancel restores the URL; confirm sends `confirmOriginChange`, then the form reflects the removal)    |
| `/app/monitors/:id`      | Overview (stored status, last/next check, a note that history arrives with the engine) and Configuration (settings, header names, body presence and size only, timestamps); pause/resume; delete dialog                                                    |

`UNKNOWN` is shown until a real check exists. "Paused" is a badge derived from `enabled = false`,
shown next to the stored status. No uptime, charts, incidents or invented results appear anywhere.

## 8. API integration

- TanStack Query with stable keys: `['monitors','list',params]` and `['monitors','detail',id]`.
- Create, edit, header changes, pause and resume store the returned monitor and invalidate the
  lists. Delete removes the detail entry and invalidates the lists.
- Forms and dialogs show their own errors, so the global error toast is suppressed for those
  mutations; other mutations still toast.
- Every screen reads from the API client. The fake API exists only in test support and the harness.

## 9. Test results (actual runs)

| Command                    | Exit | Result                                                                                                                                                                                                                                   |
| -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | 0    | shared, server, web and tests: no errors                                                                                                                                                                                                 |
| `npm run lint`             | 0    | 0 errors, 0 warnings                                                                                                                                                                                                                     |
| `npm run format:check`     | 0    | all files formatted                                                                                                                                                                                                                      |
| `npm run test`             | 0    | **17 files, 381 tests passed** (301 before this round)                                                                                                                                                                                   |
| `npm run test:integration` | 1    | **BLOCKED**: "Integration tests need Docker (for Testcontainers) or TEST_DATABASE_URL…", caused by "Could not find a working container runtime strategy". Docker is not installed and no local PostgreSQL exists; nothing was installed. |
| `npm run build`            | 0    | built; web JS 900 kB (265 kB gzip), over Vite's 500 kB warning (see §14)                                                                                                                                                                 |

New and changed tests this round (80):

- **Shared** (`monitor-url.test.ts`, +28): port policy for implicit and explicit defaults, every
  rejected custom port, bypass attempts, private addresses reported before ports, a wider future
  policy; `monitorOrigin` same and different origins. Three old cases that accepted custom ports
  were updated to the new policy.
- **Server service** (+13, real AES-GCM, in-memory repository):
  - Path, query, default-port and hostname-case changes keep secrets.
  - Scheme, host, subdomain and port changes need confirmation and change nothing without it.
  - No confirmation is needed when nothing is saved.
  - Confirmation clears headers, body and content type.
  - A new body is accepted alongside the confirmation.
  - A transaction that fails part-way keeps the whole previous configuration.
  - Credentials entered again are encrypted and decrypt correctly.
- **Server routes** (+6): the update metadata contract, `confirmOriginChange` passed through and
  rejected when alone, the 409 contract leaks nothing, `UNSUPPORTED_PORT` on create and PATCH, and
  the mixed-error top-level code.
- **Web UI** (+33, jsdom, real routes and components, fake API):
  - Registry: rendering, search, filters, pagination, empty and no-match states, error and retry,
    quota, pause/resume, delete confirm and cancel, delete failure.
  - Create: validation including the port rule and focus, success with headers, duplicate-submit
    protection, API error.
  - Edit: credential indicator, empty field keeps the value, replace, explicit removal, same-origin
    save, origin dialog (asks, cancel, confirm then re-enter, server-forced 409).
  - Details: no secrets, pause/resume, delete then redirect, not-found.
  - Shell: navigation entries, breadcrumbs, mobile navigation, sign-out, `/` redirect and overview
    count.
- **Integration suite** (+6, written, not runnable here): path and query changes keep secrets;
  scheme and host changes return 409 with nothing changed; custom port returns 400; confirmation
  clears rows, then new credentials are encrypted.

**Not counted as runtime verification:**

- The route tests use a mocked service.
- The service tests use an in-memory repository, not SQL.
- The UI tests use the fake API.

## 10. Browser results

The real routes and components ran in the in-app browser through `apps/web/harness.html`, against
the in-memory fake API with a placeholder session. A banner on every screen says so. This is
**not** the real backend or real authentication.

Verified in the browser: the registry and its row menu; delete confirmation and deletion; detail
Overview and Configuration; pause with toast; create validation with the port message and focus;
the edit form; the origin-change dialog; confirm → removal notice → cleared credentials; the
tablet (768px) and phone (375px) layouts; the mobile navigation sheet. Console: no application
errors (the only entry is the pane's own "Viewport height is too small: 0" at startup).

Defects the browser found and fixed this round:

1. At tablet width, the 240px sidebar squeezed the table into horizontal scrolling with an
   unstyled white scrollbar. The sidebar now appears from 1024px, lower-priority columns hide
   responsively, filters stack, and `color-scheme: dark` themes native scrollbars and selects.
2. At phone width, the table still overflowed. Status now sits under the monitor name and the
   name column truncates.
3. In the header editor, long "Remove Authorization" labels squeezed the value field. Visible
   labels are now "Remove"/"Undo", and the accessible names keep the header name.
4. A submit from the bottom of the form showed errors off screen. Focus now moves to the first
   invalid field (covered by a test).
5. Pages could open part-way down after navigating from a scrolled list. `ScrollRestoration` was
   added, but it is **NOT TESTED**: the hidden browser pane and the harness's memory router
   couldn't show it.

## 11. Screenshots

In `docs/screenshots/monitors/`, all taken from the harness with fake data:

`01-registry-tablet`, `02-registry-row-actions`, `03-delete-confirmation`, `04-detail-overview`,
`05-detail-configuration`, `06-detail-paused`, `07-create-validation`, `08-edit-form`,
`09-origin-change-dialog`, `10-origin-change-cleared`, `11-registry-mobile`,
`12-mobile-navigation`.

The browser pane captures at most 800×600 at 109% zoom, so a full desktop width (1024px+) could not
be captured. The desktop layout is covered by markup and UI tests only.

## 12. Remaining blockers

| Blocker                                                                          | What clears it                                                                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Integration tests (SQL, constraints, RLS, transactions, origin rule in Postgres) | Docker Desktop (owner approval to install) or a local Postgres `*_test` database in `TEST_DATABASE_URL`, then `npm run test:integration` |
| Migration `0001` never applied                                                   | A Supabase development project + `npm run db:migrate`                                                                                    |
| Real authentication, and the UI against the real API                             | The Supabase project, then `npm run dev` and repeat the browser checks against the real backend                                          |
| Remote CI                                                                        | A GitHub remote and the owner's permission to push                                                                                       |
| DNS/SSRF runtime protection                                                      | The monitoring engine, built to `docs/security/monitor-network-security.md`                                                              |
| Commit identity                                                                  | The owner's choice: the instructions say not to use the owner's email without explicit permission, so nothing has been committed         |

## 13. DNS/SSRF requirements deferred to the monitoring-engine phase

The full list is in `docs/security/monitor-network-security.md` §3:

1. Resolve A and AAAA records at connection time.
2. Reject every non-public address.
3. Reject DNS answers that mix public and private addresses.
4. Validate IPv4 and IPv6 with one shared classifier.
5. Normalise IPv4-mapped addresses.
6. Block loopback, private, link-local, unique-local and carrier-grade NAT ranges.
7. Block cloud metadata addresses.
8. Block NAT64 and 6to4 ranges that can embed private destinations.
9. Block unspecified, multicast, reserved and broadcast ranges.
10. Connect to the exact address that was validated.
11. Never do a second, uncontrolled DNS lookup while connecting.
12. Re-validate on every new connection and retry.
13. Don't follow redirects in V1.
14. Enforce network-level egress restrictions in production.

A blocked destination fails with a sanitised error.

## 14. Build results

`npm run build` exits 0:

- `@rain/shared` and `@rain/server` compile with `tsc`.
- `@rain/web`: CSS 32.6 kB (6.6 kB gzip), JS **900.3 kB (264.9 kB gzip)**.

The JS grew from 746 kB because of the monitor pages and Radix dialog, menu and tabs. Vite warns
about chunks over 500 kB. The harness and fake API are **not** in the bundle (checked by searching
the build output).

Recommended follow-up: lazy-load the `/app/monitors/*` routes. That is now worthwhile, unlike in
Phase 2.

## 15. Final acceptance matrix

| Requirement                                                                                             | Status                                                                              |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Work on `feat/monitor-management`; `main`, history and the legacy repo untouched; nothing pushed        | PASS                                                                                |
| Origin rule: same-origin path/query keeps secrets                                                       | PASS (service, UI); integration BLOCKED                                             |
| Origin rule: scheme / host / port change → 409, nothing changed                                         | PASS (service, route, UI); integration BLOCKED                                      |
| Origin rule: confirmation clears headers, body, content type in one transaction                         | PASS (service, UI); integration BLOCKED                                             |
| Origin rule: failed transaction keeps the previous configuration                                        | PASS (service, in-memory rollback); real-DB rollback BLOCKED                        |
| Origin rule: credentials entered again are encrypted                                                    | PASS (service); integration BLOCKED                                                 |
| 409 message reveals no secrets; `meta` reports what was cleared                                         | PASS                                                                                |
| Ports: 80/443 implicit and explicit allowed, others `UNSUPPORTED_PORT`, API-enforced                    | PASS                                                                                |
| Port policy extensible, not user-controllable                                                           | PASS                                                                                |
| DNS/SSRF requirements documented                                                                        | PASS                                                                                |
| DNS/SSRF runtime protection                                                                             | BLOCKED (monitoring engine)                                                         |
| Owner isolation, pagination, filtering, pause/resume, error contracts                                   | PASS (service and route unit tests); SQL behaviour BLOCKED                          |
| App shell: branding, responsive navigation, profile menu, sign-out, breadcrumbs, toasts                 | PASS                                                                                |
| Scroll restored to the top on navigation                                                                | NOT TESTED                                                                          |
| Registry: list, count, search, filters, pagination, stable order, add, loading/empty/error/retry        | PASS                                                                                |
| Registry columns and row actions (view, edit, pause, resume, delete)                                    | PASS                                                                                |
| UNKNOWN shown with no checks; PAUSED derived from `enabled`                                             | PASS                                                                                |
| Create form: sections, field errors, feedback, no duplicate submit, secrets never stored in the browser | PASS                                                                                |
| Edit form: non-secret prefill, "Credential configured", empty keeps, explicit remove                    | PASS                                                                                |
| Edit form: origin-change dialog with cancel and confirm, server 409 handled                             | PASS                                                                                |
| Details page: overview and configuration tabs, no raw credentials, no invented history                  | PASS                                                                                |
| Pause/resume with feedback and no duplicate requests                                                    | PASS                                                                                |
| Delete with a named confirmation, failure shown, queries refreshed                                      | PASS                                                                                |
| TanStack Query keys and invalidation for every mutation                                                 | PASS                                                                                |
| Responsive layout (tablet, phone)                                                                       | PASS (harness, browser); desktop ≥ 1024px NOT TESTED in the browser (capture limit) |
| Frontend tests listed in the brief                                                                      | PASS (33 UI tests)                                                                  |
| Backend tests listed in the brief                                                                       | PASS (unit); integration BLOCKED                                                    |
| Typecheck / lint / format / unit tests / build                                                          | PASS                                                                                |
| Integration tests against an isolated PostgreSQL                                                        | BLOCKED (no Docker, no local Postgres)                                              |
| UI against the real backend with real Supabase authentication                                           | BLOCKED                                                                             |
| Documentation (`monitor-management.md`, `monitor-network-security.md`, this report)                     | PASS                                                                                |

**Verdict:** The backend rules and the complete frontend are implemented and pass every local
check. Monitor Management is **not** fully verified. Database integration, real authentication,
end-to-end UI against the real API, and DNS/SSRF runtime protection remain BLOCKED on the external
prerequisites in §12. Do not treat it as complete until at least the integration tests and one
real end-to-end pass have run.
