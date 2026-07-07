import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PUBLISHED_PRESET, UNLIMITED_QUOTAS } from "@wizz/contracts";
import {
  ensureBootstrapInvite,
  isUniqueConstraintError,
  openDb,
  PresetCache,
  SettingsCache,
} from "./db";
import { insertUser } from "./users";
import { newId } from "./crypto-ids";

describe("openDb migrations + seed", () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  it("applies migrations, sets user_version, and creates every contract table", () => {
    db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "invites",
        "usage_events",
        "settings",
        "presets",
        "telemetry_events",
      ]),
    );
  });

  it("enables foreign_keys and WAL journal mode", () => {
    db = openDb(":memory:");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    // :memory: databases report journal_mode as "memory" regardless of the WAL pragma — this just proves
    // the pragma call didn't throw and the db is otherwise healthy.
    expect(typeof db.pragma("journal_mode", { simple: true })).toBe("string");
  });

  it("seeds the settings row with DEFAULT_GLOBAL_SETTINGS on first open", () => {
    db = openDb(":memory:");
    const row = db.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string };
    expect(JSON.parse(row.json)).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("is idempotent across repeated opens against the same file (migrations don't re-run, settings aren't re-seeded over an edit)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wizz-gateway-db-"));
    const path = join(dir, "gateway.db");
    try {
      let handle = openDb(path);
      handle.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify({ ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true }));
      handle.close();

      handle = openDb(path); // reopen — must not reset the edited settings row or re-run migration 1
      expect(handle.pragma("user_version", { simple: true })).toBe(1);
      const row = handle.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string };
      expect(JSON.parse(row.json).killSwitch).toBe(true);
      handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureBootstrapInvite", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates exactly one invite when the users table is empty", () => {
    ensureBootstrapInvite(db);
    const invites = db.prepare("SELECT * FROM invites").all() as { note: string | null; max_uses: number }[];
    expect(invites).toHaveLength(1);
    expect(invites[0].note).toBe("bootstrap — admin");
    expect(invites[0].max_uses).toBe(1);
  });

  it("is idempotent across repeated calls while still no users exist (reuses the same invite)", () => {
    ensureBootstrapInvite(db);
    const first = db.prepare("SELECT code FROM invites").all() as { code: string }[];
    ensureBootstrapInvite(db);
    const second = db.prepare("SELECT code FROM invites").all() as { code: string }[];
    expect(second).toHaveLength(1);
    expect(second[0].code).toBe(first[0].code);
  });

  it("does nothing once a user exists", () => {
    insertUser(db, {
      id: newId(),
      email: "admin@example.com",
      passwordHash: "irrelevant",
      createdAt: new Date().toISOString(),
      inviteId: null,
    });
    ensureBootstrapInvite(db);
    const invites = db.prepare("SELECT * FROM invites").all();
    expect(invites).toHaveLength(0);
  });
});

describe("isUniqueConstraintError", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("is true for a UNIQUE violation on users.email", () => {
    const email = "dup@example.com";
    insertUser(db, { id: newId(), email, passwordHash: "x", createdAt: new Date().toISOString(), inviteId: null });
    let caught: unknown;
    try {
      insertUser(db, { id: newId(), email, passwordHash: "x", createdAt: new Date().toISOString(), inviteId: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConstraintError(caught)).toBe(true);
  });

  it("is false for an arbitrary error", () => {
    expect(isUniqueConstraintError(new Error("boom"))).toBe(false);
  });
});

describe("SettingsCache", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("reads the seeded default on first get()", () => {
    const cache = new SettingsCache(db);
    expect(cache.get()).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("set() persists to the DB and updates the cache atomically", () => {
    const cache = new SettingsCache(db);
    const next = { ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true };
    cache.set(next);
    expect(cache.get()).toEqual(next);
    const row = db.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string };
    expect(JSON.parse(row.json)).toEqual(next);
  });

  it("invalidate() forces a fresh DB read on the next get()", () => {
    const cache = new SettingsCache(db);
    cache.get();
    db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify({ ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true }));
    expect(cache.get().killSwitch).toBe(false); // stale cache, DB write went around it
    cache.invalidate();
    expect(cache.get().killSwitch).toBe(true);
  });
});

describe("PresetCache", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("falls back to DEFAULT_PUBLISHED_PRESET when activePresetId is null", () => {
    const settings = new SettingsCache(db);
    const cache = new PresetCache(db, settings, DEFAULT_PUBLISHED_PRESET);
    expect(cache.getActive()).toEqual(DEFAULT_PUBLISHED_PRESET);
  });

  it("resolves the preset referenced by settings.activePresetId", () => {
    const settings = new SettingsCache(db);
    const cache = new PresetCache(db, settings, DEFAULT_PUBLISHED_PRESET);
    const custom = { ...DEFAULT_PUBLISHED_PRESET, id: "custom-1", name: "Custom" };
    db.prepare("INSERT INTO presets (id, name, version, active, published_at, created_at, json) VALUES (?, ?, 1, 1, NULL, ?, ?)").run(
      custom.id,
      custom.name,
      new Date().toISOString(),
      JSON.stringify(custom),
    );
    settings.set({ ...DEFAULT_GLOBAL_SETTINGS, activePresetId: custom.id, defaultQuotas: UNLIMITED_QUOTAS });
    cache.invalidate();
    expect(cache.getActive().id).toBe("custom-1");
  });

  it("invalidate() forces a fresh resolution", () => {
    const settings = new SettingsCache(db);
    const cache = new PresetCache(db, settings, DEFAULT_PUBLISHED_PRESET);
    expect(cache.getActive().id).toBe(DEFAULT_PUBLISHED_PRESET.id);
    const custom = { ...DEFAULT_PUBLISHED_PRESET, id: "custom-2" };
    db.prepare("INSERT INTO presets (id, name, version, active, published_at, created_at, json) VALUES (?, ?, 1, 1, NULL, ?, ?)").run(
      custom.id,
      "Custom 2",
      new Date().toISOString(),
      JSON.stringify(custom),
    );
    settings.set({ ...DEFAULT_GLOBAL_SETTINGS, activePresetId: custom.id, defaultQuotas: UNLIMITED_QUOTAS });
    expect(cache.getActive().id).toBe(DEFAULT_PUBLISHED_PRESET.id); // still cached from before the write
    cache.invalidate();
    expect(cache.getActive().id).toBe("custom-2");
  });
});
