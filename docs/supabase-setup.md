# Supabase setup

RAIN uses Supabase for two things: **Auth** (users, sessions, password recovery) and **Postgres**
(the database Drizzle migrates). Use a separate Supabase project for development; never point a
local checkout at production.

## 1. Create a project

Create a project at <https://supabase.com/dashboard>. Note the database password you choose.

## 2. Copy the values into `.env`

Copy `.env.example` to `.env` at the repository root, then fill in:

| Variable                        | Where to find it                                                                  | Exposed to browser? |
| ------------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| `SUPABASE_URL`                  | Project Settings → Data API → Project URL                                         | No (server)         |
| `VITE_SUPABASE_URL`             | Same value as `SUPABASE_URL`                                                      | Yes                 |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Project Settings → API Keys → publishable key (`sb_publishable_…`) or legacy anon | Yes                 |
| `DATABASE_URL`                  | **Connect** → Session pooler URI. Keep `?sslmode=require`                         | No (server)         |
| `SUPABASE_JWT_SECRET`           | Only for legacy HS256 signing — see step 3                                        | No (server)         |
| `ENCRYPTION_KEY`                | Not from Supabase: generate locally (command below). Required                     | No (server)         |

Generate `ENCRYPTION_KEY` (a random 32-byte key, base64) and keep a backup of it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`ENCRYPTION_KEY_VERSION`, `ENCRYPTION_PREVIOUS_KEYS` and `MAX_MONITORS_PER_USER` can keep their
defaults; see the README's "Encryption keys" section for rotation.

Never put the `sb_secret_…` / `service_role` key in any `VITE_*` variable. The web app refuses to
start if it detects one there, because everything in `VITE_*` is shipped to every visitor.
The API does not need the service-role key at all.

## 3. JWT signing keys

The API verifies every access token itself (signature, `iss`, `aud`, `exp`, `sub`, and
`role = authenticated`). The issuer is derived as `${SUPABASE_URL}/auth/v1`.

- **Asymmetric signing keys (recommended, default for new projects).** Tokens are signed with
  ES256/RS256 and verified against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` using `jose`.
  Leave `SUPABASE_JWT_SECRET` empty.
- **Legacy shared secret (HS256).** Older projects may still sign with the shared JWT secret
  (Project Settings → JWT Keys → Legacy JWT Secret). Set `SUPABASE_JWT_SECRET` to that value.
  The API then accepts HS256 tokens signed with it, and still uses JWKS for asymmetric tokens, so
  migrating the project to signing keys later needs no code change. Remove the secret once the
  legacy key is revoked.

## 4. Auth URL configuration

Authentication → URL Configuration:

- **Site URL:** `http://localhost:5173`
- **Redirect URLs:** add `http://localhost:5173/reset-password` and `http://localhost:5173/`

Registration sends the confirmation email back to `/`, and password recovery sends the user to
`/reset-password`. Both use `window.location.origin`, so add the equivalent URLs for any other
origin you deploy to.

Email confirmation is on by default in Supabase. With it on, a new user must click the link in
the email before they can sign in; the registration page tells them so.

## 5. Run the migration

```bash
npm run db:migrate
```

This creates `public.profiles` with a foreign key to `auth.users(id)` and Row Level Security
enabled with no policies, so Supabase's public Data API cannot read or write it. Only the RAIN
API, connecting through `DATABASE_URL`, touches the table.

## 6. Check it works

```bash
npm run dev
```

1. `http://localhost:3000/readyz` should return `{"status":"ready",...}`.
2. Open `http://localhost:5173`, register, confirm the email, and sign in.
3. The overview page calls `GET /api/v1/me`; the first call creates your `profiles` row.
