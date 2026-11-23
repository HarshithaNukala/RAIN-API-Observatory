# Deployment guide

RAIN deploys as three independent pieces sharing one PostgreSQL database (Supabase):

| Piece  | Build output                 | Start command                                   | Scales                |
| ------ | ---------------------------- | ----------------------------------------------- | --------------------- |
| API    | `apps/server/dist/api.js`    | `npm run start -w @rain/server`                 | Horizontally          |
| Worker | `apps/server/dist/worker.js` | `npm run start:worker -w @rain/server`          | Horizontally (leased) |
| Web    | `apps/web/dist/` (static)    | Any static host with SPA fallback to index.html | CDN                   |

> **Status:** this guide describes how to deploy. RAIN V1 has **not** been deployed to any hosted
> environment yet; the steps below were exercised locally only (production build, independent API
> and worker start, health endpoints, graceful shutdown).

## 1. Build

```bash
npm ci
npm run build          # shared → server (tsc) → web (vite)
```

The web build reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` **at build time**.
Never put a secret or service-role key in a `VITE_` variable; the app refuses to start with one.

## 2. Migrate the database

Migrations are SQL files in `apps/server/drizzle/` (`0000`–`0007`), applied in order by drizzle-kit:

```bash
DATABASE_URL=postgresql://… npm run db:migrate
```

- Run this once per release, **before** starting the new API and worker, from CI or an operator
  machine with dev dependencies installed (drizzle-kit is a dev dependency; runtime images don't
  need it).
- Migrations are additive and never edited after release. Back up the database first.
- Use the Supabase direct or session-pooler URI with `?sslmode=require`. The transaction pooler
  (port 6543) is not suitable for migrations.

## 3. Configure

Every variable is documented in [`.env.example`](../.env.example). In production, set them in the
platform's secret store, not a file.

| Variable                                                               | API | Worker | Notes                                                |
| ---------------------------------------------------------------------- | :-: | :----: | ---------------------------------------------------- |
| `NODE_ENV=production`                                                  |  ✓  |   ✓    |                                                      |
| `DATABASE_URL`                                                         |  ✓  |   ✓    | `sslmode=require`                                    |
| `SUPABASE_URL`, `SUPABASE_JWT_AUDIENCE`                                |  ✓  |        | `SUPABASE_JWT_SECRET` only for legacy HS256 projects |
| `ENCRYPTION_KEY`, `ENCRYPTION_KEY_VERSION`, `ENCRYPTION_PREVIOUS_KEYS` |  ✓  |   ✓    | Same values on both; back the key up                 |
| `PORT`, `CORS_ORIGINS`, `TRUST_PROXY`                                  |  ✓  |        | `TRUST_PROXY` = number of proxy hops (usually 1)     |
| `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`                            |  ✓  |   ✓    | Optional; without them email deliveries fail visibly |
| `APP_BASE_URL`                                                         |     |   ✓    | Public web URL used in notification links            |
| `WORKER_*`, `NOTIFY_*`                                                 |     |   ✓    | Tuning; defaults are fine for V1                     |

Both processes validate configuration at startup and exit with status 1 and a list of problems
(variable names only, never values) when something is missing or malformed.

`TRUST_PROXY` matters: rate limiting (including the public status-page limit) keys on the client
IP, so it must match the real number of reverse-proxy hops. `0` behind a proxy makes every client
share one limit; too high lets clients spoof `X-Forwarded-For`.

## 4. Health checks

| Endpoint       | Meaning                                                                     | Use for        |
| -------------- | --------------------------------------------------------------------------- | -------------- |
| `GET /healthz` | Process is up (`200 {"status":"ok"}`)                                       | Liveness       |
| `GET /readyz`  | Database reachable and auth keys loaded; `503` with per-check status if not | Readiness / LB |

The worker exposes no HTTP port; supervise it as a process and watch its logs
(`monitoring worker polling`, `claiming checks failed` with backoff when the database is down).

## 5. Graceful shutdown

- **API:** on `SIGTERM`/`SIGINT` stops accepting connections, finishes in-flight requests, closes
  the database pool; forces exit after 10 s.
- **Worker:** on `SIGTERM`/`SIGINT` stops claiming, waits up to `WORKER_SHUTDOWN_GRACE_MS`
  (default 35 s) for in-flight checks and deliveries. Anything unfinished is safe: its lease
  expires and another worker re-claims it; attempt IDs prevent double recording.

Set the platform's termination grace period above `WORKER_SHUTDOWN_GRACE_MS` (e.g. 45 s).

## 6. Network egress

| From   | To                               | Why                                  |
| ------ | -------------------------------- | ------------------------------------ |
| API    | PostgreSQL                       | Data                                 |
| API    | `SUPABASE_URL` (HTTPS)           | JWKS for access-token verification   |
| Worker | PostgreSQL                       | Claims, results, outbox              |
| Worker | Public internet, TCP 80/443, DNS | Monitored APIs and customer webhooks |
| Worker | `api.resend.com` (HTTPS)         | Email, when configured               |

The worker's SSRF-safe transport refuses private, loopback, link-local and metadata addresses on
its own, but defence in depth is recommended: run the worker in a network segment that **cannot
reach internal services or the cloud metadata endpoint** (169.254.169.254) at the network layer.
Do not route worker egress through an HTTP proxy — DNS pinning relies on direct connections.

## 7. Web hosting

- Serve `apps/web/dist/` with a fallback of every unknown path to `index.html` (client-side routes
  include `/app/…` and public status pages at `/status/<slug>`).
- Route `/api/*`, `/healthz` and `/readyz` to the API on the same origin, or set the API origin in
  `CORS_ORIGINS`.
- Recommended response headers for the static site: a Content-Security-Policy allowing
  `script-src 'self'`, `connect-src 'self' https://<project>.supabase.co`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `font-src https://fonts.gstatic.com`, and `frame-ancestors 'none'`;
  `Referrer-Policy: no-referrer`; HSTS. The API already sets Helmet's defaults on its own
  responses.
- Fonts: the UI uses the Plus Jakarta Sans typeface from Google Fonts (linked in `apps/web/index.html`), so
  visitors' browsers, including public status-page visitors, request it from Google. To avoid that
  third-party request, self-host the font files and remove the two `fonts.*` entries above.
- Supabase Auth: add the production web URL to the project's Site URL and redirect allow-list.

## 8. Release checklist

1. `npm run typecheck && npm run lint && npm test && npm run test:integration` (integration needs
   Docker or a disposable `*_test` database).
2. Back up the database; `npm run db:migrate`.
3. Deploy API → check `/readyz` is `200`.
4. Deploy worker → confirm `worker started` and no repeated `claiming checks failed` logs.
5. Deploy web; sign in, create a monitor, run **Check now**, open a public status page.
