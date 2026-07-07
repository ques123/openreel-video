/**
 * ID/token/code generation. Pure node:crypto — no new dependency needed.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** 32-byte random session token (hex, 64 chars) — the cookie value. */
export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** sha256 hex of a session token — what actually gets stored (sessions.token_hash). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Crockford-style base32 alphabet with the confusable set (0, O, 1, I) removed
 * entirely (stricter than plain Crockford, which keeps 0/1 as digits and only
 * excludes I/L/O/U) — "code format WZ-XXXX-XXXX crockford, no 0/O/1/I" per
 * contracts §2. 30 symbols: 8 digits + 22 letters.
 */
const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomAlphabetString(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

/** WZ-XXXX-XXXX using INVITE_ALPHABET, e.g. "WZ-7F3K-9MQR". */
export function newInviteCode(): string {
  return `WZ-${randomAlphabetString(INVITE_ALPHABET, 4)}-${randomAlphabetString(INVITE_ALPHABET, 4)}`;
}

/** Normalizes user-typed invite codes for lookup: trim + uppercase (codes are generated uppercase-only). */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * A readable one-time temp password for admin-triggered resets — longer than
 * WIZZ_PASSWORD_MIN_LENGTH and drawn from a mixed-case+digit alphabet (still
 * excluding the same confusable characters) for decent entropy
 * (~36^20 space) while staying easy to read/type off an admin screen.
 */
const TEMP_PASSWORD_ALPHABET = "23456789abcdefghjkmnpqrstvwxyzABCDEFGHJKMNPQRSTVWXYZ";

export function generateTempPassword(length = 20): string {
  return randomAlphabetString(TEMP_PASSWORD_ALPHABET, length);
}
