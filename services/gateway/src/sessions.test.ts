import { describe, expect, it } from "vitest";
import { RATE_LIMITS } from "@wizz/contracts";
import { buildAppDeps, createApp } from "./app";
import { openDb } from "./db";
import { loadEnv } from "./env";
import { createLoginLimiter, createRateLimiter } from "./rate-limit";
import { ADMIN_ORIGIN, PUBLIC_ORIGIN, seedInvite, setupTest } from "./test-helpers";

async function signupRequestSetCookie(env: ReturnType<typeof loadEnv>, requestInit: RequestInit = {}): Promise<string> {
  const db = openDb(":memory:");
  const { code } = seedInvite(db);
  const deps = buildAppDeps(db, env, {
    loginLimiter: createLoginLimiter(),
    proxyUserLimiter: createRateLimiter(RATE_LIMITS.perUserPerMinute),
    proxyIpLimiter: createRateLimiter(RATE_LIMITS.perIpPerMinute),
    telemetryLimiter: createRateLimiter(RATE_LIMITS.telemetryPerUserPerMinute),
  });
  const app = createApp("public", deps);
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, ...(requestInit.headers as Record<string, string>) },
    body: JSON.stringify({ inviteCode: code, email: "a@example.com", password: "hunter2222" }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("session cookie attributes", () => {
  it("always sets HttpOnly, SameSite=Lax, and Path=/", async () => {
    const env = loadEnv({
      WIZZ_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      WIZZ_ADMIN_ORIGIN: ADMIN_ORIGIN,
      WIZZ_INSECURE_COOKIES: "1",
    } as NodeJS.ProcessEnv);
    const setCookie = await signupRequestSetCookie(env);
    expect(setCookie).toMatch(/httponly/i);
    expect(setCookie).toMatch(/samesite=lax/i);
    expect(setCookie).toMatch(/path=\//i);
  });

  it("is Secure when WIZZ_INSECURE_COOKIES=1, even over plain http", async () => {
    const env = loadEnv({
      WIZZ_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      WIZZ_ADMIN_ORIGIN: ADMIN_ORIGIN,
      WIZZ_INSECURE_COOKIES: "1",
    } as NodeJS.ProcessEnv);
    const setCookie = await signupRequestSetCookie(env);
    expect(setCookie).toMatch(/secure/i);
  });

  it("without the insecure override: Secure is on when x-forwarded-proto is https, off when it's http", async () => {
    const env = loadEnv({
      WIZZ_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      WIZZ_ADMIN_ORIGIN: ADMIN_ORIGIN,
      // WIZZ_INSECURE_COOKIES intentionally unset
    } as NodeJS.ProcessEnv);

    const httpsCookie = await signupRequestSetCookie(env, { headers: { "x-forwarded-proto": "https" } });
    expect(httpsCookie).toMatch(/secure/i);

    const httpCookie = await signupRequestSetCookie(env, { headers: { "x-forwarded-proto": "http" } });
    expect(httpCookie).not.toMatch(/secure/i);
  });
});

describe("clientIp", () => {
  it("prefers x-forwarded-for over any other source, taking the first entry", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db);
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_ORIGIN,
        "x-forwarded-for": "203.0.113.5, 10.0.0.1",
      },
      body: JSON.stringify({ inviteCode: code, email: "a@example.com", password: "hunter2222" }),
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT ip FROM sessions").get() as { ip: string };
    expect(row.ip).toBe("203.0.113.5");
  });
});
