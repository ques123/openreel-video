import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PUBLISHED_PRESET, UNLIMITED_QUOTAS } from "@wizz/contracts";
import { newId } from "./crypto-ids";
import { ADMIN_ORIGIN, PUBLIC_ORIGIN, seedInvite, setupTest, signUpUser } from "./test-helpers";

describe("admin surface split", () => {
  it("every /api/admin/* route 403s admin_only on the public listener, for every method, with no session and no Origin needed", async () => {
    const { publicApp } = setupTest();
    const getRes = await publicApp.request("/api/admin/health");
    expect(getRes.status).toBe(403);
    expect((await getRes.json() as any).error.code).toBe("admin_only");

    const postRes = await publicApp.request("/api/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json" }, // deliberately no Origin — admin_only must win regardless
      body: JSON.stringify({ maxUses: 1 }),
    });
    expect(postRes.status).toBe(403);
    expect((await postRes.json() as any).error.code).toBe("admin_only");

    const patchRes = await publicApp.request("/api/admin/users/nonexistent", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect((await patchRes.json() as any).error.code).toBe("admin_only");
  });

  it("admin routes work on the admin listener with zero session/cookie required", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/admin/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("non-admin routes (auth/preset/quota/telemetry/proxy) are still reachable on the admin listener", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/auth/session");
    expect(res.status).toBe(401); // reachable and behaving normally — just not admin_only'd
  });

  it("an unmatched path returns the not_found envelope", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect((await res.json() as any).error.code).toBe("not_found");
  });
});

describe("GET /api/admin/health", () => {
  it("reports db counts and killSwitch state", async () => {
    const { adminApp, publicApp, db } = setupTest();
    await signUpUser(publicApp, db);
    const res = await adminApp.request("/api/admin/health");
    const body = (await res.json()) as {
      ok: boolean;
      db: { ok: boolean; users: number; usageEvents: number; sizeBytes: number };
      killSwitch: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.db.users).toBe(2); // the one signup + the seeded synthetic tailnet admin
    expect(body.db.sizeBytes).toBeGreaterThan(0);
    expect(body.killSwitch).toBe(false);
  });
});

describe("admin users", () => {
  it("lists users with a usage rollup and supports the q= search filter", async () => {
    const { adminApp, publicApp, db } = setupTest();
    await signUpUser(publicApp, db, { email: "alice@example.com" });
    await signUpUser(publicApp, db, { email: "bob@example.com" });

    const all = await adminApp.request("/api/admin/users");
    const allBody = (await all.json()) as { users: { email: string; usage: { events: number } }[] };
    expect(allBody.users).toHaveLength(3); // 2 signups + the synthetic tailnet admin (included by design)
    expect(allBody.users.some((u) => u.email === "admin@tailnet")).toBe(true);
    expect(allBody.users[0].usage).toEqual({
      today: { directorTokens: 0, cloudCaptionFrames: 0, sttSeconds: 0, sunoGens: 0 },
      total: { directorTokens: 0, cloudCaptionFrames: 0, sttSeconds: 0, sunoGens: 0 },
      knownCostUSD: 0,
      events: 0,
    });

    const filtered = await adminApp.request("/api/admin/users?q=alice");
    const filteredBody = (await filtered.json()) as { users: { email: string }[] };
    expect(filteredBody.users).toHaveLength(1);
    expect(filteredBody.users[0].email).toBe("alice@example.com");
  });

  it("GET /api/admin/users/:id returns the summary plus up to 100 recent events; 404 for unknown ids", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { userId } = await signUpUser(publicApp, db);
    db.prepare(
      `INSERT INTO usage_events (id, user_id, provider, category, model, prompt_tokens, completion_tokens,
         cached_tokens, frames, seconds, units, actual_cost_usd, upstream_status, at)
       VALUES (?, ?, 'openai', 'director', 'gpt-5.4-mini', 100, 20, 0, NULL, NULL, NULL, 0.001, 200, ?)`,
    ).run(newId(), userId, new Date().toISOString());

    const res = await adminApp.request(`/api/admin/users/${userId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { usage: { events: number } }; recent: unknown[] };
    expect(body.user.usage.events).toBe(1);
    expect(body.recent).toHaveLength(1);

    const missing = await adminApp.request("/api/admin/users/does-not-exist");
    expect(missing.status).toBe(404);
  });

  it("PATCH toggles disabled and merges quotaOverrides per the sparse-patch rules", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { userId } = await signUpUser(publicApp, db);

    const disableRes = await adminApp.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ disabled: true }),
    });
    expect(disableRes.status).toBe(200);
    expect(((await disableRes.json()) as { user: { disabled: boolean } }).user.disabled).toBe(true);

    const overrideRes = await adminApp.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ quotaOverrides: { sttSeconds: 500 } }),
    });
    const overrideBody = (await overrideRes.json()) as { user: { quotaOverrides: Record<string, number> | null } };
    expect(overrideBody.user.quotaOverrides).toEqual({ sttSeconds: 500 });

    const addAnother = await adminApp.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ quotaOverrides: { sunoGens: 3 } }),
    });
    expect(((await addAnother.json()) as { user: { quotaOverrides: Record<string, number> } }).user.quotaOverrides).toEqual({
      sttSeconds: 500,
      sunoGens: 3,
    });

    const clearOne = await adminApp.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ quotaOverrides: { sttSeconds: null } }),
    });
    expect(((await clearOne.json()) as { user: { quotaOverrides: Record<string, number> } }).user.quotaOverrides).toEqual({
      sunoGens: 3,
    });

    const clearAll = await adminApp.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ quotaOverrides: null }),
    });
    expect(((await clearAll.json()) as { user: { quotaOverrides: unknown } }).user.quotaOverrides).toBeNull();
  });

  it("PATCH rejects an unknown quota category", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { userId } = await signUpUser(publicApp, db);
    const res = await adminApp.request(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ quotaOverrides: { notARealCategory: 1 } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("bad_request");
  });

  it("reset-password returns a fresh temp password that immediately works for login", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { userId, email } = await signUpUser(publicApp, db, { password: "original-password" });

    const res = await adminApp.request(`/api/admin/users/${userId}/reset-password`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(res.status).toBe(200);
    const { tempPassword } = (await res.json()) as { tempPassword: string };
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);

    const oldLogin = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email, password: "original-password" }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await publicApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ email, password: tempPassword }),
    });
    expect(newLogin.status).toBe(200);
  });
});

describe("admin invites", () => {
  it("creates an invite with the WZ-XXXX-XXXX format and lists it", async () => {
    const { adminApp } = setupTest();
    const createRes = await adminApp.request("/api/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ maxUses: 5, note: "launch batch" }),
    });
    expect(createRes.status).toBe(200);
    const { invite } = (await createRes.json()) as { invite: { code: string; maxUses: number; note: string } };
    expect(invite.code).toMatch(/^WZ-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(invite.maxUses).toBe(5);
    expect(invite.note).toBe("launch batch");

    const listRes = await adminApp.request("/api/admin/invites");
    const { invites } = (await listRes.json()) as { invites: { code: string }[] };
    expect(invites.some((i) => i.code === invite.code)).toBe(true);
  });

  it("rejects a non-positive/non-integer maxUses", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ maxUses: 0 }),
    });
    expect((await res.json() as any).error.code).toBe("bad_request");
  });

  it("PATCH disables an invite, which then fails signup redemption", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { id, code } = seedInvite(db);
    const patchRes = await adminApp.request(`/api/admin/invites/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ disabled: true }),
    });
    expect(patchRes.status).toBe(200);

    const signupRes = await publicApp.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ inviteCode: code, email: "x@example.com", password: "hunter2222" }),
    });
    expect((await signupRes.json() as any).error.code).toBe("invite_invalid");
  });

  it("404s a PATCH on an unknown invite id", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/admin/invites/does-not-exist", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("admin usage rollup", () => {
  async function seedUsage(db: ReturnType<typeof setupTest>["db"], userId: string) {
    const insert = db.prepare(
      `INSERT INTO usage_events (id, user_id, provider, category, model, prompt_tokens, completion_tokens,
         cached_tokens, frames, seconds, units, actual_cost_usd, upstream_status, at)
       VALUES (@id, @userId, @provider, @category, @model, @promptTokens, @completionTokens, 0, NULL, NULL, NULL, @cost, 200, @at)`,
    );
    insert.run({
      id: newId(),
      userId,
      provider: "openai",
      category: "director",
      model: "gpt-5.4-mini",
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.001,
      at: "2026-07-07T10:00:00.000Z",
    });
    insert.run({
      id: newId(),
      userId,
      provider: "openrouter",
      category: "director",
      model: "qwen/qwen3.7-max",
      promptTokens: 200,
      completionTokens: 80,
      cost: null,
      at: "2026-07-06T10:00:00.000Z",
    });
  }

  it("groups by day and provider, and sums knownCostUSD only over rows that reported one", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { userId } = await signUpUser(publicApp, db);
    await seedUsage(db, userId);

    const res = await adminApp.request("/api/admin/usage?groupBy=day,provider&from=2026-07-01&to=2026-07-31");
    expect(res.status).toBe(200);
    const { rows } = (await res.json()) as {
      rows: { day: string; provider: string; events: number; knownCostUSD: number | null; costedEvents: number }[];
    };
    expect(rows).toHaveLength(2);
    const openaiRow = rows.find((r) => r.provider === "openai")!;
    expect(openaiRow.events).toBe(1);
    expect(openaiRow.knownCostUSD).toBeCloseTo(0.001);
    expect(openaiRow.costedEvents).toBe(1);
    const openrouterRow = rows.find((r) => r.provider === "openrouter")!;
    expect(openrouterRow.knownCostUSD).toBeNull(); // its one row had a null cost
    expect(openrouterRow.costedEvents).toBe(0);
  });

  it("returns a single overall total row when groupBy is omitted", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { userId } = await signUpUser(publicApp, db);
    await seedUsage(db, userId);
    const res = await adminApp.request("/api/admin/usage?from=2026-07-01&to=2026-07-31");
    const { rows } = (await res.json()) as { rows: { events: number; promptTokens: number }[] };
    expect(rows).toHaveLength(1);
    expect(rows[0].events).toBe(2);
    expect(rows[0].promptTokens).toBe(300);
  });

  it("respects the from/to date range (exclusive of days outside it)", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { userId } = await signUpUser(publicApp, db);
    await seedUsage(db, userId);
    const res = await adminApp.request("/api/admin/usage?from=2026-07-07&to=2026-07-07");
    const { rows } = (await res.json()) as { rows: { events: number }[] };
    expect(rows[0].events).toBe(1); // only the 07-07 row
  });

  it("rejects an unknown groupBy dimension", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/admin/usage?groupBy=bogus");
    expect((await res.json() as any).error.code).toBe("bad_request");
  });
});

describe("admin settings", () => {
  it("GET returns the current (seeded default) settings", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/admin/settings");
    expect(await res.json()).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("PUT validates shape and persists a full replace", async () => {
    const { adminApp } = setupTest();
    const next = { ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true, defaultQuotas: { ...UNLIMITED_QUOTAS, sttSeconds: 3600 } };
    const res = await adminApp.request("/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify(next),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(next);

    const getRes = await adminApp.request("/api/admin/settings");
    expect(await getRes.json()).toEqual(next);
  });

  it("PUT rejects a malformed body (missing footageCap)", async () => {
    const { adminApp } = setupTest();
    const { footageCap: _drop, ...rest } = DEFAULT_GLOBAL_SETTINGS;
    const res = await adminApp.request("/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects activePresetId referencing a preset that doesn't exist", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ ...DEFAULT_GLOBAL_SETTINGS, activePresetId: "no-such-preset" }),
    });
    expect(res.status).toBe(400);
  });

  it("a kill-switched settings write immediately blocks the proxy", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    await adminApp.request("/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true }),
    });
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie, "x-wizz-category": "director" },
      body: JSON.stringify({ model: "gpt-5.4-mini", messages: [] }),
    });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error.code).toBe("kill_switch");
  });
});

describe("admin presets", () => {
  it("creates a preset from DEFAULT_PUBLISHED_PRESET when the body is empty, and lists it", async () => {
    const { adminApp } = setupTest();
    const createRes = await adminApp.request("/api/admin/presets", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: "",
    });
    expect(createRes.status).toBe(200);
    const { preset } = (await createRes.json()) as { preset: { id: string; version: number; name: string } };
    expect(preset.version).toBe(1);
    expect(preset.name).toBe(DEFAULT_PUBLISHED_PRESET.name);

    const listRes = await adminApp.request("/api/admin/presets");
    const { presets } = (await listRes.json()) as { presets: { id: string }[] };
    expect(presets.some((p) => p.id === preset.id)).toBe(true);
  });

  it("creates a preset from a partial body merged over the default", async () => {
    const { adminApp } = setupTest();
    const res = await adminApp.request("/api/admin/presets", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ name: "Launch preset", musicEnabled: false }),
    });
    const { preset } = (await res.json()) as { preset: { name: string; musicEnabled: boolean; directorModel: string } };
    expect(preset.name).toBe("Launch preset");
    expect(preset.musicEnabled).toBe(false);
    expect(preset.directorModel).toBe(DEFAULT_PUBLISHED_PRESET.directorModel); // inherited from the default
  });

  it("PUT bumps the version and merges over the existing preset", async () => {
    const { adminApp } = setupTest();
    const createRes = await adminApp.request("/api/admin/presets", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: "",
    });
    const { preset: created } = (await createRes.json()) as { preset: { id: string } };

    const putRes = await adminApp.request(`/api/admin/presets/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ name: "Updated name" }),
    });
    const { preset: updated } = (await putRes.json()) as { preset: { version: number; name: string } };
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("Updated name");
  });

  it("activate sets settings.activePresetId, stamps publishedAt, and the public /api/preset reflects it", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);

    const createRes = await adminApp.request("/api/admin/presets", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ name: "Special" }),
    });
    const { preset: created } = (await createRes.json()) as { preset: { id: string } };

    const activateRes = await adminApp.request(`/api/admin/presets/${created.id}/activate`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(activateRes.status).toBe(200);
    const { preset: activated } = (await activateRes.json()) as { preset: { publishedAt: string | null } };
    expect(activated.publishedAt).not.toBeNull();

    const settingsRes = await adminApp.request("/api/admin/settings");
    expect(((await settingsRes.json()) as { activePresetId: string }).activePresetId).toBe(created.id);

    // Read the preset back through every other path — proves publishedAt was persisted into the stored
    // json blob itself (not just echoed back on the activate response and the published_at column).
    const publicPresetRes = await publicApp.request("/api/preset", { headers: { cookie } });
    const publicPreset = (await publicPresetRes.json()) as { preset: { id: string; name: string; publishedAt: string | null } };
    expect(publicPreset.preset.id).toBe(created.id);
    expect(publicPreset.preset.name).toBe("Special");
    expect(publicPreset.preset.publishedAt).toBe(activated.publishedAt);

    const listRes = await adminApp.request("/api/admin/presets");
    const { presets: allPresets } = (await listRes.json()) as { presets: { id: string; publishedAt: string | null }[] };
    expect(allPresets.find((p) => p.id === created.id)?.publishedAt).toBe(activated.publishedAt);
  });

  it("404s PUT/activate on an unknown preset id", async () => {
    const { adminApp } = setupTest();
    const putRes = await adminApp.request("/api/admin/presets/nope", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ name: "x" }),
    });
    expect(putRes.status).toBe(404);
    const activateRes = await adminApp.request("/api/admin/presets/nope/activate", {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(activateRes.status).toBe(404);
  });
});

describe("admin telemetry rollup", () => {
  it("returns typed counts grouped by day/user/type", async () => {
    const { adminApp, publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    await publicApp.request("/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie },
      body: JSON.stringify({ type: "session_start" }),
    });
    const res = await adminApp.request("/api/admin/telemetry");
    const { rows } = (await res.json()) as { rows: { type: string; count: number }[] };
    expect(rows.some((r) => r.type === "session_start" && r.count === 1)).toBe(true);
  });
});
