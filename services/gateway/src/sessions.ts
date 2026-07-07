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
import { WIZZ_SESSION_COOKIE, WIZZ_SESSION_TTL_DAYS } from "@wizz/contracts";
import { hashToken, newSessionToken } from "./crypto-ids";
import { getUserRowById, mapUserRow, touchUserLastSeen } from "./users";
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
 * The shared session gate for every session-required route (preset, quota,
 * telemetry, proxy). Validates the cookie, loads + disabled-checks the user,
 * performs the rolling refresh, and attaches `user` to context. Throws
 * WizzError("auth_required" | "account_disabled") — caught by app.onError.
 */
export function requireSession(db: Database.Database, env: GatewayEnv): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const token = getCookie(c, WIZZ_SESSION_COOKIE);
    if (!token) throw new WizzError("auth_required");

    const tokenHash = hashToken(token);
    const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
      | SessionRow
      | undefined;

    const now = new Date();
    if (!session || Date.parse(session.expires_at) <= now.getTime()) {
      clearSessionCookie(c, env);
      throw new WizzError("auth_required");
    }

    const userRow = getUserRowById(db, session.user_id);
    if (!userRow) {
      clearSessionCookie(c, env);
      throw new WizzError("auth_required");
    }
    const user = mapUserRow(userRow);
    if (user.disabled) throw new WizzError("account_disabled");

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

    c.set("user", user);
    c.set("sessionTokenHash", tokenHash);
    await next();
  };
}
