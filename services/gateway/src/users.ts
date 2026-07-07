/**
 * users table row CRUD + the DB-row -> AdminUser mapping shared by auth.ts,
 * sessions.ts, and admin.ts. AdminUser (from @wizz/contracts) is used as the
 * canonical in-process "full user" shape everywhere — PublicUser is just its
 * {id, email, createdAt} projection, applied at the HTTP boundary.
 */
import type Database from "better-sqlite3";
import type { AdminUser, PublicUser, QuotaLimits } from "@wizz/contracts";

/**
 * The synthetic tailnet-admin identity: on the ADMIN listener, /api/proxy/*,
 * /api/preset, /api/quota and /api/telemetry resolve to this reserved user
 * row when no (usable) real session cookie is present — the admin SPA has no
 * login because arriving on the tailnet listener IS the identity. The row is
 * seeded idempotently by openDb (db.ts) so metering/quota attribution has a
 * real users row to hang off; its lab spend shows up in the Usage section —
 * that's a feature, not leakage.
 *
 * Login as this account is impossible by construction, twice over: the
 * password_hash sentinel below is not a valid argon2 digest (verify() can
 * only fail on it), and handleLogin short-circuits the id to
 * invalid_credentials before even calling verify. The email is additionally
 * unregisterable via signup ("admin@tailnet" has no dot in its domain, so
 * isPlausibleEmail rejects it before uniqueness is ever consulted).
 */
export const SYNTHETIC_ADMIN_USER_ID = "admin";
export const SYNTHETIC_ADMIN_EMAIL = "admin@tailnet";
/** Deliberately not an argon2 digest — argon2.verify() rejects it as malformed, which auth.ts maps to "no match". */
export const SYNTHETIC_ADMIN_PASSWORD_SENTINEL = "*tailnet-identity-no-password*";

export function isSyntheticAdmin(userId: string): boolean {
  return userId === SYNTHETIC_ADMIN_USER_ID;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  disabled: number;
  last_seen_at: string | null;
  invite_id: string | null;
  quota_overrides: string | null;
}

export function mapUserRow(row: UserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    disabled: row.disabled === 1,
    quotaOverrides: row.quota_overrides ? (JSON.parse(row.quota_overrides) as Partial<QuotaLimits>) : null,
    lastSeenAt: row.last_seen_at,
    inviteId: row.invite_id,
  };
}

export function toPublicUser(user: AdminUser): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export function getUserRowById(db: Database.Database, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUserRowByEmail(db: Database.Database, email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
}

export interface NewUserInput {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  inviteId: string | null;
}

/** Throws whatever better-sqlite3 throws on a UNIQUE violation (email) — callers map that to email_taken. */
export function insertUser(db: Database.Database, input: NewUserInput): void {
  db.prepare(
    "INSERT INTO users (id, email, password_hash, created_at, disabled, last_seen_at, invite_id, quota_overrides) " +
      "VALUES (?, ?, ?, ?, 0, NULL, ?, NULL)",
  ).run(input.id, input.email, input.passwordHash, input.createdAt, input.inviteId);
}

export function updateUserPasswordHash(db: Database.Database, id: string, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function updateUserDisabled(db: Database.Database, id: string, disabled: boolean): void {
  db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id);
}

export function updateUserQuotaOverrides(
  db: Database.Database,
  id: string,
  overrides: Partial<QuotaLimits> | null,
): void {
  db.prepare("UPDATE users SET quota_overrides = ? WHERE id = ?").run(
    overrides ? JSON.stringify(overrides) : null,
    id,
  );
}

export function touchUserLastSeen(db: Database.Database, id: string, atISO: string): void {
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(atISO, id);
}

export function searchUsers(db: Database.Database, q: string | undefined): UserRow[] {
  if (q && q.trim()) {
    const like = `%${q.trim().toLowerCase()}%`;
    return db
      .prepare("SELECT * FROM users WHERE LOWER(email) LIKE ? ORDER BY created_at DESC")
      .all(like) as UserRow[];
  }
  return db.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as UserRow[];
}
