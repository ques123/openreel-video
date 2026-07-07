import { afterEach, describe, expect, it, vi } from "vitest";
import { WIZZ_SESSION_COOKIE } from "@wizz/contracts";
import { extractCookie, PUBLIC_ORIGIN, seedInvite, setupTest, signUpUser } from "./test-helpers";
import { hashToken } from "./crypto-ids";

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/auth/signup", () => {
  it("creates a user + session on a valid invite, returns the public user shape, and sets the cookie", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db);
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: "New.User@Example.com  ", password: "hunter2222" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string; createdAt: string } };
    expect(body.user.email).toBe("new.user@example.com"); // lowercased + trimmed
    expect(typeof body.user.id).toBe("string");
    const cookie = extractCookie(res, WIZZ_SESSION_COOKIE);
    expect(cookie).toMatch(new RegExp(`^${WIZZ_SESSION_COOKIE}=[0-9a-f]{64}$`));

    const row = db.prepare("SELECT used_count FROM invites WHERE code = ?").get(code) as { used_count: number };
    expect(row.used_count).toBe(1);
  });

  it("rejects an unknown invite code with invite_invalid", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: "WZ-0000-0000", email: "a@example.com", password: "hunter2222" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("invite_invalid");
  });

  it("rejects a disabled invite", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db, { disabled: true });
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: "a@example.com", password: "hunter2222" }),
    });
    expect((await res.json() as any).error.code).toBe("invite_invalid");
  });

  it("rejects an expired invite", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: "a@example.com", password: "hunter2222" }),
    });
    expect((await res.json() as any).error.code).toBe("invite_invalid");
  });

  it("rejects an exhausted invite (usedCount >= maxUses)", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db, { maxUses: 1, usedCount: 1 });
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: "a@example.com", password: "hunter2222" }),
    });
    expect((await res.json() as any).error.code).toBe("invite_invalid");
  });

  it("rejects a duplicate email with email_taken", async () => {
    const { publicApp, db } = setupTest();
    await signUpUser(publicApp, db, { email: "dup@example.com" });
    const { code } = seedInvite(db);
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: "DUP@example.com", password: "hunter2222" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("email_taken");
  });

  it("rejects a password under WIZZ_PASSWORD_MIN_LENGTH with weak_password", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db);
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: "a@example.com", password: "short1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("weak_password");
  });

  it("rejects a malformed body with bad_request", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email: "a@example.com" }), // missing inviteCode/password
    });
    expect((await res.json() as any).error.code).toBe("bad_request");
  });

  it("rejects a request with a missing/mismatched Origin header with bad_origin", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db);
    const noOrigin = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteCode: code, email: "a@example.com", password: "hunter2222" }),
    });
    expect(noOrigin.status).toBe(403);
    expect((await noOrigin.json() as any).error.code).toBe("bad_origin");

    const wrongOrigin = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ inviteCode: code, email: "b@example.com", password: "hunter2222" }),
    });
    expect((await wrongOrigin.json() as any).error.code).toBe("bad_origin");
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials and sets a fresh session cookie", async () => {
    const { publicApp, db } = setupTest();
    const { email } = await signUpUser(publicApp, db, { email: "login@example.com", password: "hunter2222" });
    const res = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email, password: "hunter2222" }),
    });
    expect(res.status).toBe(200);
    expect(extractCookie(res, WIZZ_SESSION_COOKIE)).toMatch(/^wizz_session=[0-9a-f]{64}$/);
  });

  it("rejects an unknown email with invalid_credentials", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email: "nobody@example.com", password: "hunter2222" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json() as any).error.code).toBe("invalid_credentials");
  });

  it("rejects a wrong password with invalid_credentials", async () => {
    const { publicApp, db } = setupTest();
    const { email } = await signUpUser(publicApp, db, { password: "hunter2222" });
    const res = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    expect((await res.json() as any).error.code).toBe("invalid_credentials");
  });

  it("rejects a disabled account with account_disabled (only after the password checks out)", async () => {
    const { publicApp, db } = setupTest();
    const { email, userId } = await signUpUser(publicApp, db, { password: "hunter2222" });
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);

    const wrongPassword = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email, password: "wrong" }),
    });
    expect((await wrongPassword.json() as any).error.code).toBe("invalid_credentials"); // not account_disabled

    const rightPassword = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email, password: "hunter2222" }),
    });
    expect(rightPassword.status).toBe(403);
    expect((await rightPassword.json() as any).error.code).toBe("account_disabled");
  });

  it("rate-limits login to 10/min/IP with a machine-readable retryAfterS", async () => {
    const { publicApp } = setupTest();
    const headers = {
      "content-type": "application/json",
      origin: PUBLIC_ORIGIN,
      "x-forwarded-for": "203.0.113.9",
    };
    const body = JSON.stringify({ email: "nobody@example.com", password: "x" });
    for (let i = 0; i < 10; i += 1) {
      const res = await publicApp.request("/api/auth/login", { method: "POST", headers, body });
      expect(res.status).toBe(401); // invalid_credentials, still under the limit
    }
    const eleventh = await publicApp.request("/api/auth/login", { method: "POST", headers, body });
    expect(eleventh.status).toBe(429);
    const errBody = (await eleventh.json()) as { error: { code: string; retryAfterS: number } };
    expect(errBody.error.code).toBe("rate_limited");
    expect(errBody.error.retryAfterS).toBeGreaterThan(0);
  });

  it("tracks the rate limit per-IP, not globally", async () => {
    const { publicApp } = setupTest();
    const body = JSON.stringify({ email: "nobody@example.com", password: "x" });
    for (let i = 0; i < 10; i += 1) {
      await publicApp.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "x-forwarded-for": "10.0.0.1" },
        body,
      });
    }
    const otherIp = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "x-forwarded-for": "10.0.0.2" },
      body,
    });
    expect(otherIp.status).toBe(401); // not rate-limited — different IP
  });
});

describe("POST /api/auth/logout", () => {
  it("is idempotent — 204 even with no cookie at all", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/logout", {
      method: "POST",
      headers: { origin: PUBLIC_ORIGIN },
    });
    expect(res.status).toBe(204);
  });

  it("deletes the session row and clears the cookie", async () => {
    const { publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    const tokenHash = hashToken(cookie.split("=")[1]);
    expect(db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(tokenHash)).toBeDefined();

    const res = await publicApp.request("/api/auth/logout", {
      method: "POST",
      headers: { origin: PUBLIC_ORIGIN, cookie },
    });
    expect(res.status).toBe(204);
    expect(db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(tokenHash)).toBeUndefined();

    const sessionRes = await publicApp.request("/api/auth/session", { headers: { cookie } });
    expect(sessionRes.status).toBe(401);
  });
});

describe("GET /api/auth/session", () => {
  it("returns auth_required with no cookie", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/session");
    expect(res.status).toBe(401);
    expect((await res.json() as any).error.code).toBe("auth_required");
  });

  it("returns the public user shape for a valid session", async () => {
    const { publicApp, db } = setupTest();
    const { cookie, email } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/auth/session", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe(email);
  });

  it("returns auth_required and clears the cookie for an expired session", async () => {
    const { publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    const tokenHash = hashToken(cookie.split("=")[1]);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      tokenHash,
    );
    const res = await publicApp.request("/api/auth/session", { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(extractCookie(res, WIZZ_SESSION_COOKIE)).toBe("wizz_session="); // cleared: empty value
  });

  it("returns auth_required for a well-formed but unknown token", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/session", {
      headers: { cookie: "wizz_session=" + "a".repeat(64) },
    });
    expect(res.status).toBe(401);
  });

  it("rolling refresh: a session untouched for >1 day gets its expiry (and users.last_seen_at) pushed forward, and re-issues the cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { publicApp, db } = setupTest();
    const { cookie, userId } = await signUpUser(publicApp, db);
    const tokenHash = hashToken(cookie.split("=")[1]);
    const before = db.prepare("SELECT expires_at, last_used_at FROM sessions WHERE token_hash = ?").get(tokenHash) as {
      expires_at: string;
      last_used_at: string;
    };

    vi.setSystemTime(new Date("2026-01-02T00:00:00.001Z")); // just over 1 day later
    const res = await publicApp.request("/api/auth/session", { headers: { cookie } });
    expect(res.status).toBe(200);

    const after = db.prepare("SELECT expires_at, last_used_at FROM sessions WHERE token_hash = ?").get(tokenHash) as {
      expires_at: string;
      last_used_at: string;
    };
    expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.parse(before.expires_at));
    expect(Date.parse(after.last_used_at)).toBeGreaterThan(Date.parse(before.last_used_at));
    expect(extractCookie(res, WIZZ_SESSION_COOKIE)).toMatch(/^wizz_session=[0-9a-f]{64}$/); // re-issued

    const user = db.prepare("SELECT last_seen_at FROM users WHERE id = ?").get(userId) as { last_seen_at: string };
    expect(user.last_seen_at).toBe(after.last_used_at);
  });

  it("rolling refresh does NOT trigger for a session used less than a day ago", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    const tokenHash = hashToken(cookie.split("=")[1]);
    const before = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as {
      expires_at: string;
    };

    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z")); // 12h later, under the 1-day threshold
    const res = await publicApp.request("/api/auth/session", { headers: { cookie } });
    expect(res.status).toBe(200);

    const after = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as {
      expires_at: string;
    };
    expect(after.expires_at).toBe(before.expires_at); // untouched
  });
});
