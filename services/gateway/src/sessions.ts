/**
 * Session cookie lifecycle: creation (signup/login), validation +
 * rolling refresh (every session-gated route), and logout.
 *
 * Cookie: wizz_session, httpOnly, SameSite=Lax, Path=/, 30d (contracts §2).
 * Secure is set whenever the request arrived over https (trusting
 * x-forwarded-proto — nginx sets this; the gateway itself only ever binds
 * 127.0.0.1 behind it) OR WIZZ_INSECURE_COOKIES=1 for local http dev/tests —
 * production never sets that env var, so Secure is always on in prod.
 *
 * Rolling refresh (contracts §0): a session is good for 30 days from its
 * last use; we only rewrite expires_at (and last_used_at, and users.last_
 * seen_at, and re-issue the Set-Cookie so the BROWSER's own maxAge rolls
 * forward too — otherwise the cookie could expire client-side before the DB
 * row would) when more than a day has passed since the last touch, which
 * throttles writes to at most once/day/session instead of every request.
 */
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { CookieOptions } from "hono/utils/cookie";
import type Database from "better-sqlite3";
import { WIZZ_SESSION_COOKIE, WIZZ_SESSION_TTL_DAYS, type AdminUser } from "@wizz/contracts";
import { hashToken, newSessionToken } from "./crypto-ids";
import { getUserRowById, mapUserRow, touchUserLastSeen, SYNTHETIC_ADMIN_USER_ID } from "./users";
import { WizzError } from "./errors";
import type { GatewayEnv } from "./env";
import type { Vars } from "./context";

const SESSION_TTL_MS = WIZZ_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const ROLLING_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * The gateway only ever binds 127.0.0.1 with nginx in front (never exposed
 * directly), so x-forwarded-for is trustworthy here — it's the standard
 * reverse-proxy header nginx sets (proxy_set_header X-Forwarded-For
 * $proxy_add_x_forwarded_for) and WS-A's nginx contract must configure it.
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    if (remote) return remote;
  } catch {
    // no real connection info available (e.g. Hono's in-memory app.request() in tests)
  }
  return "unknown";
}

/** Same trust boundary as clientIp: nginx sets x-forwarded-proto (proxy_set_header X-Forwarded-Proto $scheme). */
export function isHttpsRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto) return proto.split(",")[0]?.trim().toLowerCase() === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function cookieOptions(c: Context, env: GatewayEnv, maxAgeS?: number): CookieOptions {
  const secure = isHttpsRequest(c) || env.insecureCookies;
  return {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    ...(maxAgeS !== undefined ? { maxAge: maxAgeS } : {}),
  };
}

function setSessionCookie(c: Context, env: GatewayEnv, token: string): void {
  setCookie(c, WIZZ_SESSION_COOKIE, token, cookieOptions(c, env, WIZZ_SESSION_TTL_DAYS * 24 * 60 * 60));
}

export function clearSessionCookie(c: Context, env: GatewayEnv): void {
  deleteCookie(c, WIZZ_SESSION_COOKIE, { path: "/", secure: isHttpsRequest(c) || env.insecureCookies });
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  ip: string | null;
  user_agent: string | null;
}

/** Creates a session row + sets the cookie. Used by both signup and login. */
export function createSession(db: Database.Database, env: GatewayEnv, c: Context, userId: string): void {
  const token = newSessionToken();
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, ip, user_agent) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    tokenHash,
    userId,
    now.toISOString(),
    expiresAt,
    now.toISOString(),
    clientIp(c),
    c.req.header("user-agent") ?? null,
  );
  setSessionCookie(c, env, token);
}

export function deleteSessionByRawToken(db: Database.Database, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

/**
 * Attempts to resolve (and rolling-refresh) a real session from the cookie.
 * "none" covers no cookie / unknown token / expired session / dangling user
 * reference (the stale-cookie cases also clear the cookie); "disabled" is a
 * VALID session whose user the admin has disabled (no refresh performed).
 * How each outcome maps to a response is the caller's policy — requireSession
 * is strict, sessionOrSyntheticAdmin substitutes the tailnet identity.
 */
type SessionResolution =
  | { kind: "ok"; user: AdminUser; tokenHash: string }
  | { kind: "disabled" }
  | { kind: "none" };

function resolveSessionFromCookie(
  db: Database.Database,
  env: GatewayEnv,
  c: Context<{ Variables: Vars }>,
): SessionResolution {
  const token = getCookie(c, WIZZ_SESSION_COOKIE);
  if (!token) return { kind: "none" };

  const tokenHash = hashToken(token);
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
    | SessionRow
    | undefined;

  const now = new Date();
  if (!session || Date.parse(session.expires_at) <= now.getTime()) {
    clearSessionCookie(c, env);
    return { kind: "none" };
  }

  const userRow = getUserRowById(db, session.user_id);
  if (!userRow) {
    clearSessionCookie(c, env);
    return { kind: "none" };
  }
  const user = mapUserRow(userRow);
  if (user.disabled) return { kind: "disabled" };

  if (now.getTime() - Date.parse(session.last_used_at) > ROLLING_REFRESH_THRESHOLD_MS) {
    const newExpiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    db.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?").run(
      now.toISOString(),
      newExpiresAt,
      tokenHash,
    );
    touchUserLastSeen(db, user.id, now.toISOString());
    setSessionCookie(c, env, token);
  }

  return { kind: "ok", user, tokenHash };
}

/** The strict mapping shared by requireSession and sessionOrSyntheticAdmin's public branch — byte-identical by construction. */
function applyStrictSession(c: Context<{ Variables: Vars }>, resolution: SessionResolution): void {
  if (resolution.kind === "none") throw new WizzError("auth_required");
  if (resolution.kind === "disabled") throw new WizzError("account_disabled");
  c.set("user", resolution.user);
  c.set("sessionTokenHash", resolution.tokenHash);
}

/**
 * The strict session gate (used by GET /api/auth/session, and by anything
 * that must behave identically on both listeners). Validates the cookie,
 * loads + disabled-checks the user, performs the rolling refresh, and
 * attaches `user` to context. Throws WizzError("auth_required" |
 * "account_disabled") — caught by app.onError.
 */
export function requireSession(db: Database.Database, env: GatewayEnv): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    applyStrictSession(c, resolveSessionFromCookie(db, env, c));
    await next();
  };
}

/**
 * The gate for the four session-scoped route groups (/api/proxy/*,
 * /api/preset, /api/quota, /api/telemetry):
 *
 * - PUBLIC surface: exactly requireSession (same resolution, same strict
 *   mapping — the shared applyStrictSession makes "byte-identical" a
 *   structural fact, not a promise).
 * - ADMIN surface: no session needed — tailnet arrival is the identity. A
 *   usable real session cookie is PREFERRED when present (a signed-in-
 *   elsewhere cookie attributes usage to that account instead of the
 *   synthetic one); anything less than a usable session (no cookie, expired,
 *   unknown token, or even a disabled user's cookie) falls back to the
 *   synthetic admin row rather than erroring — a stray cookie must never
 *   break the admin surface, that's the whole point of this gate.
 */
export function sessionOrSyntheticAdmin(
  db: Database.Database,
  env: GatewayEnv,
): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    if (c.get("surface") === "admin") {
      const resolution = resolveSessionFromCookie(db, env, c);
      if (resolution.kind === "ok") {
        c.set("user", resolution.user);
        c.set("sessionTokenHash", resolution.tokenHash);
      } else {
        const row = getUserRowById(db, SYNTHETIC_ADMIN_USER_ID);
        // Unreachable in practice — openDb seeds the row on every open. Guarded so a hand-edited DB
        // degrades to a clean 401 instead of a crash.
        if (!row) throw new WizzError("auth_required");
        c.set("user", mapUserRow(row));
      }
    } else {
      applyStrictSession(c, resolveSessionFromCookie(db, env, c));
    }
    await next();
  };
}
