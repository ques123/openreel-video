# @wizz/gateway

Auth + metered LLM proxy for wizz.video. Hono + better-sqlite3, two HTTP
listeners from one process: a **public** listener (session-checked, rate
limited, `/api/admin/*` always 403s `admin_only`) and an **admin** listener
(tailnet-only in production; admin routes work there with no session at all —
"arrived on the tailnet" is a port-binding fact, not a forgeable header).

Full HTTP/schema spec: `docs/wizz-contracts.md` (gitignored ops doc, read it
from disk). Shared types/constants: `@wizz/contracts`
(`packages/contracts/src/index.ts`) — this service never redefines them.

## Run in dev

```
pnpm --filter @wizz/gateway dev
```

This runs `tsx watch src/index.ts`. With no env vars set at all it will:

- open/create `./dev.db` (WAL, migrations applied automatically)
- listen on `127.0.0.1:8792` (public) and `127.0.0.1:8793` (admin)
- treat both `WIZZ_PUBLIC_ORIGIN` and `WIZZ_ADMIN_ORIGIN` as
  `http://localhost:5173` (vite's default dev server), so the web app's dev
  server can hit this gateway with zero configuration
- print a warning listing which `WIZZ_*_KEY` env vars are missing (proxy
  calls to those providers will fail upstream auth, but the server still
  boots — useful for auth/admin-only local work without real keys)
- **on the very first boot**, when the `users` table is empty, mint and print
  a bootstrap invite code to stdout (see below)

`dev.db` (and `dev.db-shm`/`dev.db-wal`) are gitignored — never commit them.

## Run tests

```
pnpm --filter @wizz/gateway test:run   # one-shot
pnpm --filter @wizz/gateway test       # watch mode
```

185 tests across 11 files, each using a fresh in-memory (`:memory:`)
SQLite database. The proxy's upstream `fetch` is fully injectable
(`ProxyDeps.fetchImpl`) — tests never hit the network; `src/test-helpers.ts`
(not itself a test file) is the shared scaffolding every `*.test.ts` builds
its app/db through.

## Build + run the production bundle

```
pnpm --filter @wizz/gateway build   # -> dist/index.mjs + dist/migrations/*.sql
pnpm --filter @wizz/gateway start   # node dist/index.mjs
```

`build` is a single esbuild bundle (`--bundle --platform=node --format=esm`)
with `better-sqlite3` and `@node-rs/argon2` kept external (both ship native
addons — bundling them doesn't make sense; they resolve from
`node_modules` at runtime same as any other Node dependency), followed by a
copy step that puts the migration `.sql` files next to the bundle
(`dist/migrations/`) since esbuild only follows `import`s, not
`fs.readFileSync` paths — `src/db.ts` resolves the migrations directory via
`import.meta.url`, which points at `dist/` after bundling and `src/` under
`tsx`/vitest, so the same resolution logic works in both.

## Module map

| File | Responsibility |
|---|---|
| `env.ts` | Env parsing + local-dev defaults |
| `db.ts` | DB open/pragmas/migrations, settings seed, bootstrap invite, session GC, `SettingsCache`/`PresetCache` |
| `context.ts` | Shared Hono `Variables` shape (`surface`, `user`, `sessionTokenHash`) |
| `errors.ts` | `WizzError`, the error envelope builder, `app.onError`/`errorResponse` |
| `crypto-ids.ts` | IDs, session tokens, invite codes, temp passwords (all `node:crypto`) |
| `users.ts` | `users` table row CRUD + DB-row → `AdminUser` mapping |
| `sessions.ts` | Cookie lifecycle: create/validate/rolling-refresh/clear, `requireSession` middleware, `clientIp`/`isHttpsRequest` |
| `csrf.ts` | Origin-header check on mutating methods |
| `rate-limit.ts` | In-memory sliding-window limiter + the login/proxy/telemetry instances |
| `quota.ts` | Effective-limit resolution, quotaOverrides merge-patch, UTC-day windowing, "used today" SQL, `QuotaStatus` assembly |
| `usage-parse.ts` | Pure usage parsing (openai/openrouter chat usage, groq seconds/cost, caption frame counting) — mirrors the client's cost-truth semantics |
| `request-utils.ts` | `parseJsonBody`, a light email sanity check |
| `auth.ts` | signup (transactional invite redemption)/login/logout/session routes |
| `proxy.ts` | `ALL /api/proxy/:provider/*` — the 10-step check order, route-matching + usage-derivation pure helpers, the handler |
| `product.ts` | `GET /api/preset`, `GET /api/quota` |
| `telemetry.ts` | `POST /api/telemetry` |
| `admin.ts` | Every `/api/admin/*` route (users, invites, usage rollup, settings, presets, health, telemetry rollup) |
| `app.ts` | `createApp(surface, deps)` — wires middleware order + every route module onto one Hono instance per listener |
| `index.ts` | Env parse, DB open+migrate, build both apps, two `serve()` calls, graceful SIGTERM/SIGINT |
| `test-helpers.ts` | Shared test scaffolding (not a test file itself) |
| `migrations/001_init.sql` | Full schema (contracts §3) |

## Env contract

Production reads `/etc/wizz/gateway.env` (systemd `EnvironmentFile`) — see
`WIZZ_ENV_KEYS` in `@wizz/contracts` for the authoritative list
(`WIZZ_DB_PATH`, `WIZZ_PORT_PUBLIC`, `WIZZ_PORT_ADMIN`, `WIZZ_PUBLIC_ORIGIN`,
`WIZZ_ADMIN_ORIGIN`, `WIZZ_OPENAI_KEY`, `WIZZ_OPENROUTER_KEY`,
`WIZZ_GROQ_KEY`, `WIZZ_SUNO_KEY`). One gateway-internal var beyond that
contract:

- `WIZZ_INSECURE_COOKIES=1` — dev/test only. Marks the session cookie
  `Secure` even when the request didn't arrive over https. **Production must
  never set this.** Without it, the cookie's `Secure` flag is derived from
  `x-forwarded-proto` (falling back to the request URL's own scheme) — this
  gateway always binds `127.0.0.1` behind nginx, so it trusts that header;
  nginx must set `proxy_set_header X-Forwarded-Proto $scheme;` (and, for
  accurate per-IP rate limiting/session IP recording, `X-Forwarded-For
  $proxy_add_x_forwarded_for;`) on both vhosts.
- `WIZZ_BUILD_VERSION` — optional override for `AdminHealth.version` (falls
  back to `package.json`'s version). A deploy script can inject the real git
  SHA here without this package ever touching git itself.

Local dev defaults (used whenever the corresponding env var is absent):
`WIZZ_DB_PATH=./dev.db`, ports `8792`/`8793` (contracts' defaults),
`WIZZ_PUBLIC_ORIGIN`/`WIZZ_ADMIN_ORIGIN=http://localhost:5173`. Missing
provider keys log a warning at boot but don't prevent it from starting.

## The bootstrap invite

On every boot, `ensureBootstrapInvite` checks whether the `users` table is
empty. If it is, and no invite exists yet at all, it mints one
(`maxUses: 1`, `note: "bootstrap — admin"`) and prints its code to stdout —
that's how the admin creates the very first account. If the table is still
empty on a later restart (the invite was never used), it re-prints the
**same** code instead of minting a new one, so a restart never strands you
without ever having seen the code. Once any user exists, this is a no-op
forever.

## Notable design choices / contract judgment calls

- **quotaOverrides storage never holds an explicit `null` under a present
  key.** The PATCH endpoint's sparse-merge semantics ("null clears one
  category") are implemented as delete-the-key, not store-null-as-override —
  see `quota.ts`'s `applyQuotaOverridesPatch`. Functionally identical to a
  stored explicit null today since v1's defaults are all unlimited; documented
  in case defaults ever go finite.
- **Caption quota pre-check boundary** ("reject if [the frames] alone would
  cross the limit") is implemented as `used + framesInThisRequest >= limit`,
  matching the same `==` rejects / one-under-passes boundary used everywhere
  else in the quota engine, for consistency.
- **`UsageEvent.upstreamStatus` is `number` on the wire but the DB column is
  nullable** (a network error/timeout has no HTTP status at all). `0` is the
  "no response received" sentinel when mapping a stored row back to the wire
  shape.
- **The proxy path whitelist does no path normalization of its own** — it's
  an exact string+method match against `PROXY_UPSTREAMS[provider].allow`.
  Both `@hono/node-server`'s request-URL builder and the WHATWG URL parser
  already collapse dot-segments/reject malformed request-targets before this
  code ever sees a path, so traversal/double-encoding/absolute-URL attempts
  either get resolved away or simply fail the exact-match — see `proxy.ts`'s
  header comment and `proxy.test.ts`'s pure-function fuzz cases.
- **suno's `GET generate/record-info` is fully unmetered**: no quota
  pre-check, no `usage_events` row at all (not just a zero-cost one) — polling
  a job would otherwise pollute the events count for no reason.
- **Admin routes are mounted on both listeners**; the public listener's
  `/api/admin/*` gate runs *before* the global CSRF check (registered first),
  so it always answers plain `admin_only` with zero Origin-header dependence.
- **No new dependencies were installed.** Everything is built from the
  pinned set (hono, @hono/node-server, better-sqlite3, @node-rs/argon2;
  vitest/tsx/esbuild/typescript) plus `node:crypto`/`node:fs`/`node:path`/`node:url`.
