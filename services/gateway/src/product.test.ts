import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PUBLISHED_PRESET, UNLIMITED_QUOTAS } from "@wizz/contracts";
import { setupTest, signUpUser } from "./test-helpers";

describe("GET /api/preset", () => {
  it("requires a session", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/preset");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe("auth_required");
  });

  it("returns DEFAULT_PUBLISHED_PRESET + the settings footageCap when no preset has been activated", async () => {
    const { publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/preset", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preset: typeof DEFAULT_PUBLISHED_PRESET;
      footageCap: typeof DEFAULT_GLOBAL_SETTINGS.footageCap;
    };
    expect(body.preset).toEqual(DEFAULT_PUBLISHED_PRESET);
    expect(body.footageCap).toEqual(DEFAULT_GLOBAL_SETTINGS.footageCap);
  });

  it("reflects an updated footageCap from settings without needing a preset change", async () => {
    const { publicApp, db, deps } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, footageCap: { maxClips: 5, maxTotalSeconds: 300 } });
    const res = await publicApp.request("/api/preset", { headers: { cookie } });
    const body = (await res.json()) as { footageCap: { maxClips: number; maxTotalSeconds: number } };
    expect(body.footageCap).toEqual({ maxClips: 5, maxTotalSeconds: 300 });
  });
});

describe("GET /api/quota", () => {
  it("requires a session", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/quota");
    expect(res.status).toBe(401);
  });

  it("returns the QuotaStatus shape: all-unlimited by default, resetsAt at the next UTC midnight, killSwitch from settings", async () => {
    const { publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/quota", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: Record<string, { limit: number | null; used: number; remaining: number | null }>;
      resetsAt: string;
      killSwitch: boolean;
    };
    expect(body.categories.directorTokens).toEqual({ limit: null, used: 0, remaining: null });
    expect(body.categories.sunoGens).toEqual({ limit: null, used: 0, remaining: null });
    expect(body.categories.cloudCaptionFrames).toEqual({ limit: null, used: 0, remaining: null });
    expect(body.categories.sttSeconds).toEqual({ limit: null, used: 0, remaining: null });
    expect(body.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(body.killSwitch).toBe(false);
  });

  it("reflects usage recorded via the proxy and a per-user override", async () => {
    const { publicApp, db } = setupTest();
    const { cookie, userId } = await signUpUser(publicApp, db);
    db.prepare("UPDATE users SET quota_overrides = ? WHERE id = ?").run(JSON.stringify({ sttSeconds: 3600 }), userId);
    db.prepare(
      `INSERT INTO usage_events (id, user_id, provider, category, model, prompt_tokens, completion_tokens,
         cached_tokens, frames, seconds, units, actual_cost_usd, upstream_status, at)
       VALUES ('evt1', ?, 'groq', 'stt', NULL, NULL, NULL, NULL, NULL, 120, NULL, 0.001, 200, ?)`,
    ).run(userId, new Date().toISOString());

    const res = await publicApp.request("/api/quota", { headers: { cookie } });
    const body = (await res.json()) as {
      categories: { sttSeconds: { limit: number | null; used: number; remaining: number | null } };
    };
    expect(body.categories.sttSeconds).toEqual({ limit: 3600, used: 120, remaining: 3480 });
  });

  it("killSwitch is true after the admin flips it", async () => {
    const { publicApp, db, deps } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true, defaultQuotas: UNLIMITED_QUOTAS });
    const res = await publicApp.request("/api/quota", { headers: { cookie } });
    expect(((await res.json()) as { killSwitch: boolean }).killSwitch).toBe(true);
  });
});
