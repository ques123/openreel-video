/**
 * The admin-surface tailnet identity delta: on the ADMIN listener,
 * /api/proxy/*, /api/preset, /api/quota and /api/telemetry work WITHOUT a
 * session cookie by resolving the reserved synthetic admin user (tailnet
 * arrival is the identity); a usable real cookie is preferred when present.
 * The public listener must remain byte-identical to before — asserted here
 * alongside the new behavior (and structurally guaranteed by the shared
 * applyStrictSession path in sessions.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS } from "@wizz/contracts";
import { ensureBootstrapInvite, openDb } from "./db";
import {
  SYNTHETIC_ADMIN_EMAIL,
  SYNTHETIC_ADMIN_PASSWORD_SENTINEL,
  SYNTHETIC_ADMIN_USER_ID,
} from "./users";
import { ADMIN_ORIGIN, PUBLIC_ORIGIN, seedInvite, setupTest, signUpUser } from "./test-helpers";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A canned successful chat completion with usage, for attribution checks (10 prompt + 5 completion tokens). */
const chatFetch = () =>
  vi.fn(async () =>
    jsonResponse(200, {
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );

const CHAT_BODY = JSON.stringify({ model: "gpt-5.4-mini", messages: [] });
const ADMIN_CHAT_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  origin: ADMIN_ORIGIN,
  "x-wizz-category": "director",
};

/* ─────────────────────── the seeded row itself ─────────────────────── */

describe("synthetic admin row seeding", () => {
  it("openDb seeds the reserved row with the never-verifiable sentinel hash", () => {
    const db = openDb(":memory:");
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(SYNTHETIC_ADMIN_USER_ID) as {
      email: string;
      password_hash: string;
      disabled: number;
    };
    expect(row.email).toBe(SYNTHETIC_ADMIN_EMAIL);
    expect(row.password_hash).toBe(SYNTHETIC_ADMIN_PASSWORD_SENTINEL);
    expect(row.disabled).toBe(0);
    db.close();
  });

  it("is idempotent across reopens of the same file (exactly one row, original created_at kept)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wizz-synthetic-admin-"));
    const path = join(dir, "gateway.db");
    try {
      let db = openDb(path);
      const first = db.prepare("SELECT created_at FROM users WHERE id = ?").get(SYNTHETIC_ADMIN_USER_ID) as {
        created_at: string;
      };
      db.close();

      db = openDb(path);
      const rows = db.prepare("SELECT created_at FROM users WHERE id = ?").all(SYNTHETIC_ADMIN_USER_ID) as {
        created_at: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].created_at).toBe(first.created_at); // OR IGNORE — not re-inserted/overwritten
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not suppress the bootstrap invite — only REAL accounts count as 'users exist'", () => {
    const db = openDb(":memory:"); // synthetic admin row already seeded here
    ensureBootstrapInvite(db);
    const invites = db.prepare("SELECT note FROM invites").all() as { note: string | null }[];
    expect(invites).toHaveLength(1);
    expect(invites[0].note).toBe("bootstrap — admin");
    db.close();
  });
});

/* ─────────────────────── admin surface: no session needed ─────────────────────── */

describe("admin surface without a session", () => {
  it("proxy forwards and writes a usage row attributed to the synthetic admin", async () => {
    const fetchImpl = chatFetch();
    const { adminApp, db } = setupTest(fetchImpl);

    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: ADMIN_CHAT_HEADERS, // no cookie at all
      body: CHAT_BODY,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const row = db.prepare("SELECT user_id, provider, category, model, prompt_tokens, completion_tokens FROM usage_events").get() as Record<string, unknown>;
    expect(row.user_id).toBe(SYNTHETIC_ADMIN_USER_ID);
    expect(row.provider).toBe("openai");
    expect(row.category).toBe("director");
    expect(row.model).toBe("gpt-5.4-mini");
    expect(row.prompt_tokens).toBe(10);
    expect(row.completion_tokens).toBe(5);
  });

  it("GET /api/preset works without a session", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/preset");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preset: { id: string } };
    expect(body.preset.id).toBe("default");
  });

  it("GET /api/quota works without a session and reflects the synthetic admin's own usage", async () => {
    const fetchImpl = chatFetch();
    const { adminApp } = setupTest(fetchImpl);
    await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: ADMIN_CHAT_HEADERS,
      body: CHAT_BODY,
    });

    const res = await adminApp.request("/api/quota");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: { directorTokens: { limit: number | null; used: number } };
    };
    expect(body.categories.directorTokens.limit).toBeNull(); // unlimited default
    expect(body.categories.directorTokens.used).toBe(15); // 10 + 5 from the proxy call above
  });

  it("POST /api/telemetry accepted without a session, attributed to the synthetic admin", async () => {
    const { adminApp, db } = setupTest();
    const res = await adminApp.request("/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ type: "session_start" }),
    });
    expect(res.status).toBe(204);
    const row = db.prepare("SELECT user_id, type FROM telemetry_events").get() as { user_id: string; type: string };
    expect(row.user_id).toBe(SYNTHETIC_ADMIN_USER_ID);
    expect(row.type).toBe("session_start");
  });

  it("the synthetic admin's lab spend rolls up in the admin Users list (spend visibility)", async () => {
    const fetchImpl = chatFetch();
    const { adminApp } = setupTest(fetchImpl);
    await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: ADMIN_CHAT_HEADERS,
      body: CHAT_BODY,
    });

    const res = await adminApp.request("/api/admin/users");
    const { users } = (await res.json()) as {
      users: { id: string; email: string; usage: { events: number; total: { directorTokens?: number } } }[];
    };
    const synthetic = users.find((u) => u.id === SYNTHETIC_ADMIN_USER_ID);
    expect(synthetic).toBeDefined();
    expect(synthetic!.email).toBe(SYNTHETIC_ADMIN_EMAIL);
    expect(synthetic!.usage.events).toBe(1);
    expect(synthetic!.usage.total.directorTokens).toBe(15);
  });
});

/* ─────────────────────── check order intact on the admin surface ─────────────────────── */

describe("admin surface: remaining proxy checks still apply", () => {
  it("kill switch still 503s admin proxy calls", async () => {
    const fetchImpl = vi.fn();
    const { adminApp, deps } = setupTest(fetchImpl);
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true });
    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: ADMIN_CHAT_HEADERS,
      body: CHAT_BODY,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe("kill_switch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("path whitelist still applies (forbidden_path, no session needed to get the answer)", async () => {
    const { adminApp } = setupTest(vi.fn());
    const res = await adminApp.request("/api/proxy/openai/evil-path", {
      method: "POST",
      headers: ADMIN_CHAT_HEADERS,
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("forbidden_path");
  });

  it("category validation still applies (missing x-wizz-category)", async () => {
    const { adminApp } = setupTest(vi.fn());
    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(400);
  });

  it("body cap still applies (413 on an oversized suno body)", async () => {
    const { adminApp } = setupTest(vi.fn());
    const res = await adminApp.request("/api/proxy/suno/generate", {
      method: "POST",
      headers: { ...ADMIN_CHAT_HEADERS, "x-wizz-category": "music" },
      body: JSON.stringify({ prompt: "x".repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it("quota checks run against the synthetic admin's overrides (a zero override blocks it)", async () => {
    const fetchImpl = vi.fn();
    const { adminApp, db } = setupTest(fetchImpl);
    db.prepare("UPDATE users SET quota_overrides = ? WHERE id = ?").run(
      JSON.stringify({ directorTokens: 0 }),
      SYNTHETIC_ADMIN_USER_ID,
    );
    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: ADMIN_CHAT_HEADERS,
      body: CHAT_BODY,
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.code).toBe("quota_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* ─────────────────────── real-cookie preference + fallbacks ─────────────────────── */

describe("admin surface with a cookie present", () => {
  it("prefers a usable real session — usage is attributed to that user, not the synthetic admin", async () => {
    const fetchImpl = chatFetch();
    const { adminApp, publicApp, db } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);

    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { ...ADMIN_CHAT_HEADERS, cookie },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT user_id FROM usage_events").get() as { user_id: string };
    expect(row.user_id).toBe(userId);
  });

  it("a garbage/unknown cookie falls back to the synthetic admin instead of 401ing", async () => {
    const fetchImpl = chatFetch();
    const { adminApp, db } = setupTest(fetchImpl);
    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { ...ADMIN_CHAT_HEADERS, cookie: `wizz_session=${"f".repeat(64)}` },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT user_id FROM usage_events").get() as { user_id: string };
    expect(row.user_id).toBe(SYNTHETIC_ADMIN_USER_ID);
  });

  it("an expired real session falls back to the synthetic admin", async () => {
    const fetchImpl = chatFetch();
    const { adminApp, publicApp, db } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    db.prepare("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());

    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { ...ADMIN_CHAT_HEADERS, cookie },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT user_id FROM usage_events").get() as { user_id: string };
    expect(row.user_id).toBe(SYNTHETIC_ADMIN_USER_ID);
  });

  it("a DISABLED user's valid cookie falls back to the synthetic admin — a stray cookie never breaks the admin surface", async () => {
    const fetchImpl = chatFetch();
    const { adminApp, publicApp, db } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);

    const res = await adminApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { ...ADMIN_CHAT_HEADERS, cookie },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(200); // NOT account_disabled — tailnet identity wins
    const row = db.prepare("SELECT user_id FROM usage_events").get() as { user_id: string };
    expect(row.user_id).toBe(SYNTHETIC_ADMIN_USER_ID);
  });
});

/* ─────────────────────── public surface byte-identical ─────────────────────── */

describe("public surface unchanged", () => {
  it("proxy still 401s without a session — never falls back to the synthetic admin", async () => {
    const fetchImpl = vi.fn();
    const { publicApp, db } = setupTest(fetchImpl);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "x-wizz-category": "director" },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe("auth_required");
    expect(fetchImpl).not.toHaveBeenCalled();
    const count = db.prepare("SELECT COUNT(*) as n FROM usage_events").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("preset, quota, and telemetry still 401 without a session", async () => {
    const { publicApp } = setupTest();
    expect((await publicApp.request("/api/preset")).status).toBe(401);
    expect((await publicApp.request("/api/quota")).status).toBe(401);
    const telemetry = await publicApp.request("/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ type: "session_start" }),
    });
    expect(telemetry.status).toBe(401);
  });

  it("a disabled user's cookie still gets account_disabled on the public proxy (no fallback there)", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie, userId } = await signUpUser(publicApp, db);
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie, "x-wizz-category": "director" },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("account_disabled");
  });
});

/* ─────────────────────── account hygiene ─────────────────────── */

describe("synthetic admin account hygiene", () => {
  it("login as admin@tailnet always fails with invalid_credentials (any password, any case), never a 500", async () => {
    const { publicApp } = setupTest();
    for (const email of [SYNTHETIC_ADMIN_EMAIL, "ADMIN@TAILNET"]) {
      const res = await publicApp.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
        body: JSON.stringify({ email, password: SYNTHETIC_ADMIN_PASSWORD_SENTINEL }),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as any).error.code).toBe("invalid_credentials");
    }
  });

  it("signup can never claim admin@tailnet (fails email validation — no dot in the domain)", async () => {
    const { publicApp, db } = setupTest();
    const { code } = seedInvite(db);
    const res = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: SYNTHETIC_ADMIN_EMAIL, password: "hunter2222" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("bad_request");
  });

  it("PATCH disabled on the synthetic admin -> 400 bad_request with a clear message (both true and false)", async () => {
    const { adminApp, db } = setupTest();
    for (const disabled of [true, false]) {
      const res = await adminApp.request(`/api/admin/users/${SYNTHETIC_ADMIN_USER_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
        body: JSON.stringify({ disabled }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("bad_request");
      expect(body.error.message).toMatch(/cannot be disabled/);
    }
    const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(SYNTHETIC_ADMIN_USER_ID) as {
      disabled: number;
    };
    expect(row.disabled).toBe(0); // untouched
  });

  it("reset-password on the synthetic admin -> 400 bad_request; the sentinel hash is untouched", async () => {
    const { adminApp, db } = setupTest();
    const res = await adminApp.request(`/api/admin/users/${SYNTHETIC_ADMIN_USER_ID}/reset-password`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toMatch(/no password/);
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(SYNTHETIC_ADMIN_USER_ID) as {
      password_hash: string;
    };
    expect(row.password_hash).toBe(SYNTHETIC_ADMIN_PASSWORD_SENTINEL);
  });

  it("quotaOverrides on the synthetic admin ARE allowed (capping the lab's own spend is legitimate)", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request(`/api/admin/users/${SYNTHETIC_ADMIN_USER_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ quotaOverrides: { sttSeconds: 7200 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { quotaOverrides: Record<string, number> } };
    expect(body.user.quotaOverrides).toEqual({ sttSeconds: 7200 });
  });

  it("GET /api/admin/users/:id works for the synthetic admin (detail view, not just the list)", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request(`/api/admin/users/${SYNTHETIC_ADMIN_USER_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(SYNTHETIC_ADMIN_USER_ID);
    expect(body.user.email).toBe(SYNTHETIC_ADMIN_EMAIL);
  });
});
