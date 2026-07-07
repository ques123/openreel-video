/**
 * Auth routes: signup (transactional invite redemption), login (+rate
 * limit), logout (idempotent), GET session. Mounted identically on both
 * listeners (contracts don't gate auth to one surface) — see app.ts.
 */
import { hash, verify } from "@node-rs/argon2";
import { getCookie } from "hono/cookie";
import type { Context, Hono } from "hono";
import type Database from "better-sqlite3";
import {
  WIZZ_PASSWORD_MIN_LENGTH,
  WIZZ_SESSION_COOKIE,
  type LoginRequest,
  type SessionResponse,
  type SignupRequest,
} from "@wizz/contracts";
import { isUniqueConstraintError } from "./db";
import { newId, normalizeInviteCode } from "./crypto-ids";
import type { GatewayEnv } from "./env";
import { WizzError } from "./errors";
import type { RateLimiter } from "./rate-limit";
import { isPlausibleEmail, parseJsonBody } from "./request-utils";
import {
  clearSessionCookie,
  clientIp,
  createSession,
  deleteSessionByRawToken,
  requireSession,
} from "./sessions";
import { getUserRowByEmail, insertUser, isSyntheticAdmin, toPublicUser } from "./users";
import type { Vars } from "./context";

/** Longer than any real password needs — just bounds the argon2 hashing cost of an abusive request body. */
const MAX_PASSWORD_LENGTH = 256;

export interface AuthDeps {
  db: Database.Database;
  env: GatewayEnv;
  loginLimiter: RateLimiter;
}

/**
 * Exported for admin.ts's reset-password action — the one other place a plaintext password gets hashed.
 * `algorithm: 2` is @node-rs/argon2's Algorithm.Argon2id — referenced by its raw value rather than the enum
 * member because it's a `const enum` and this project builds with isolatedModules (each file transpiled
 * independently, which can't safely inline a const enum from another module).
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: 2 });
}

async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored "hash" (e.g. the synthetic admin's sentinel — see users.ts) makes argon2's
    // verify() reject rather than return false; either way it means "no match", never a 500.
    return false;
  }
}

interface InviteRow {
  id: string;
  code: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  disabled: number;
  created_at: string;
  note: string | null;
}

/** unknown, disabled, expired, or exhausted all collapse to the single invite_invalid code (contracts §2). */
function assertInviteRedeemable(invite: InviteRow | undefined, now: number): asserts invite is InviteRow {
  if (!invite) throw new WizzError("invite_invalid");
  if (invite.disabled) throw new WizzError("invite_invalid");
  if (invite.expires_at && Date.parse(invite.expires_at) <= now) throw new WizzError("invite_invalid");
  if (invite.used_count >= invite.max_uses) throw new WizzError("invite_invalid");
}

async function handleSignup(c: Context<{ Variables: Vars }>, deps: AuthDeps): Promise<Response> {
  const body = await parseJsonBody<Partial<SignupRequest>>(c);
  if (
    !body ||
    typeof body.inviteCode !== "string" ||
    typeof body.email !== "string" ||
    typeof body.password !== "string"
  ) {
    throw new WizzError("bad_request");
  }

  const email = body.email.trim().toLowerCase();
  if (!isPlausibleEmail(email)) throw new WizzError("bad_request", "That doesn't look like an email address.");
  if (body.password.length < WIZZ_PASSWORD_MIN_LENGTH) throw new WizzError("weak_password");
  if (body.password.length > MAX_PASSWORD_LENGTH) throw new WizzError("bad_request", "Password is too long.");

  const code = normalizeInviteCode(body.inviteCode);
  const now = Date.now();
  // Read-check up front so an obviously-bad code fails fast before paying for the argon2 hash below;
  // the transaction below re-checks freshly to close the TOCTOU window against concurrent redemptions.
  const precheck = deps.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow | undefined;
  assertInviteRedeemable(precheck, now);

  // argon2 hashing is async; better-sqlite3 transactions must be synchronous, so the slow crypto work
  // happens BEFORE the transaction opens rather than holding a write lock across an await.
  const passwordHash = await hashPassword(body.password);

  const userId = newId();
  const createdAt = new Date().toISOString();

  try {
    const redeem = deps.db.transaction(() => {
      const fresh = deps.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as
        | InviteRow
        | undefined;
      assertInviteRedeemable(fresh, Date.now());
      const existing = deps.db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
      if (existing) throw new WizzError("email_taken");
      insertUser(deps.db, { id: userId, email, passwordHash, createdAt, inviteId: fresh.id });
      deps.db.prepare("UPDATE invites SET used_count = used_count + 1 WHERE id = ?").run(fresh.id);
    });
    redeem();
  } catch (err) {
    if (err instanceof WizzError) throw err;
    if (isUniqueConstraintError(err)) throw new WizzError("email_taken");
    throw err;
  }

  createSession(deps.db, deps.env, c, userId);
  return c.json({ user: { id: userId, email, createdAt } } satisfies SessionResponse, 200);
}

async function handleLogin(c: Context<{ Variables: Vars }>, deps: AuthDeps): Promise<Response> {
  const ip = clientIp(c);
  const limit = deps.loginLimiter.check(`login:${ip}`);
  if (!limit.ok) throw new WizzError("rate_limited", undefined, { retryAfterS: limit.retryAfterS });

  const body = await parseJsonBody<Partial<LoginRequest>>(c);
  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    throw new WizzError("bad_request");
  }

  const email = body.email.trim().toLowerCase();
  const row = getUserRowByEmail(deps.db, email);
  if (!row) throw new WizzError("invalid_credentials");
  // The synthetic tailnet admin can never log in — its sentinel hash would fail verify anyway (see
  // verifyPassword), but short-circuiting keeps the guarantee independent of argon2's behavior.
  if (isSyntheticAdmin(row.id)) throw new WizzError("invalid_credentials");

  const valid = await verifyPassword(row.password_hash, body.password);
  if (!valid) throw new WizzError("invalid_credentials");
  // Disabled is only revealed to someone who already proved they know the password — avoids using
  // account_disabled vs invalid_credentials as a free user-enumeration oracle.
  if (row.disabled) throw new WizzError("account_disabled");

  createSession(deps.db, deps.env, c, row.id);
  return c.json(
    { user: { id: row.id, email: row.email, createdAt: row.created_at } } satisfies SessionResponse,
    200,
  );
}

async function handleLogout(c: Context<{ Variables: Vars }>, deps: AuthDeps): Promise<Response> {
  const token = getCookie(c, WIZZ_SESSION_COOKIE);
  if (token) deleteSessionByRawToken(deps.db, token);
  clearSessionCookie(c, deps.env);
  return c.body(null, 204);
}

export function registerAuthRoutes(app: Hono<{ Variables: Vars }>, deps: AuthDeps): void {
  app.post("/api/auth/signup", (c) => handleSignup(c, deps));
  app.post("/api/auth/login", (c) => handleLogin(c, deps));
  app.post("/api/auth/logout", (c) => handleLogout(c, deps));
  app.get("/api/auth/session", requireSession(deps.db, deps.env), (c) => {
    const user = c.get("user");
    if (!user) throw new WizzError("auth_required");
    return c.json({ user: toPublicUser(user) } satisfies SessionResponse, 200);
  });
}
