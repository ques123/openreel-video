/**
 * Shared test scaffolding — NOT itself a test file (no .test.ts suffix, so
 * vitest won't try to run it as a suite). Every *.test.ts file that needs a
 * live app/db builds it through here so the wiring (env defaults, limiters,
 * caches) is exercised identically to production's index.ts.
 */
import { RATE_LIMITS } from "@wizz/contracts";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { type AppDeps, buildAppDeps, createApp } from "./app";
import type { Vars } from "./context";
import { openDb } from "./db";
import { loadEnv, type GatewayEnv } from "./env";
import { newId, newInviteCode } from "./crypto-ids";
import { createLoginLimiter, createRateLimiter } from "./rate-limit";

export const PUBLIC_ORIGIN = "http://public.test";
export const ADMIN_ORIGIN = "http://admin.test";

export function testEnv(overrides: Partial<Record<string, string>> = {}): GatewayEnv {
  return loadEnv({
    WIZZ_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    WIZZ_ADMIN_ORIGIN: ADMIN_ORIGIN,
    WIZZ_INSECURE_COOKIES: "1",
    WIZZ_OPENAI_KEY: "test-openai-key",
    WIZZ_OPENROUTER_KEY: "test-openrouter-key",
    WIZZ_GROQ_KEY: "test-groq-key",
    WIZZ_SUNO_KEY: "test-suno-key",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestSetup {
  db: Database.Database;
  env: GatewayEnv;
  deps: AppDeps;
  publicApp: Hono<{ Variables: Vars }>;
  adminApp: Hono<{ Variables: Vars }>;
}

export function setupTest(fetchImpl: typeof fetch = () => Promise.reject(new Error("fetch not stubbed"))): TestSetup {
  const db = openDb(":memory:");
  const env = testEnv();
  const deps = buildAppDeps(
    db,
    env,
    {
      loginLimiter: createLoginLimiter(),
      proxyUserLimiter: createRateLimiter(RATE_LIMITS.perUserPerMinute),
      proxyIpLimiter: createRateLimiter(RATE_LIMITS.perIpPerMinute),
      telemetryLimiter: createRateLimiter(RATE_LIMITS.telemetryPerUserPerMinute),
    },
    fetchImpl,
  );
  return { db, env, deps, publicApp: createApp("public", deps), adminApp: createApp("admin", deps) };
}

export interface SeedInviteOptions {
  code?: string;
  maxUses?: number;
  usedCount?: number;
  expiresAt?: string | null;
  disabled?: boolean;
  note?: string | null;
}

export function seedInvite(db: Database.Database, opts: SeedInviteOptions = {}): { id: string; code: string } {
  const id = newId();
  const code = opts.code ?? newInviteCode();
  db.prepare(
    "INSERT INTO invites (id, code, max_uses, used_count, expires_at, disabled, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    code,
    opts.maxUses ?? 1,
    opts.usedCount ?? 0,
    opts.expiresAt ?? null,
    opts.disabled ? 1 : 0,
    new Date().toISOString(),
    opts.note ?? null,
  );
  return { id, code };
}

/** Extracts "name=value" from a response's Set-Cookie (handles undici's getSetCookie() when present). */
export function extractCookie(res: Response, name: string): string {
  const withGetter = res.headers as Headers & { getSetCookie?: () => string[] };
  const all = typeof withGetter.getSetCookie === "function" ? withGetter.getSetCookie() : [];
  const raw = all.find((h) => h.startsWith(`${name}=`)) ?? (res.headers.get("set-cookie") ?? undefined);
  if (!raw) throw new Error(`no ${name} cookie in response`);
  return raw.split(";")[0];
}

export interface SignedUpSession {
  cookie: string;
  email: string;
  userId: string;
}

/** Signs up a fresh user against a live app and returns their session cookie header value. */
export async function signUpUser(
  app: Hono<{ Variables: Vars }>,
  db: Database.Database,
  opts: { email?: string; password?: string; origin?: string } = {},
): Promise<SignedUpSession> {
  const { code } = seedInvite(db);
  const email = opts.email ?? `user-${newId()}@example.com`;
  const password = opts.password ?? "correct-horse-battery-staple";
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: opts.origin ?? PUBLIC_ORIGIN },
    body: JSON.stringify({ inviteCode: code, email, password }),
  });
  if (res.status !== 200) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const cookie = extractCookie(res, "wizz_session");
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, email, userId: body.user.id };
}
