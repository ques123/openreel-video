/**
 * Small HTTP-layer helpers shared by route modules (auth.ts, admin.ts).
 */
import type { Context } from "hono";

/** Parses the body as JSON; null on empty body or invalid JSON (callers map that to bad_request). */
export async function parseJsonBody<T>(c: Context): Promise<T | null> {
  try {
    const text = await c.req.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A minimal sanity gate, not a full RFC5322 validator — just enough to reject obvious garbage. */
export function isPlausibleEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);
}
