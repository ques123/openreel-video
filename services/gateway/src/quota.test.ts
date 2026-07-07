import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db";
import { newId } from "./crypto-ids";
import {
  applyQuotaOverridesPatch,
  buildQuotaStatus,
  effectiveQuotaLimit,
  nextUtcMidnightISO,
  precheckQuota,
  quotaCategoryFor,
  QuotaStore,
  utcMidnightISO,
} from "./quota";
import { DEFAULT_GLOBAL_SETTINGS, UNLIMITED_QUOTAS, type GlobalSettings } from "@wizz/contracts";

describe("utcMidnightISO / nextUtcMidnightISO", () => {
  it("floors to UTC midnight and advances by exactly one day", () => {
    const d = new Date("2026-07-07T15:42:03.123Z");
    expect(utcMidnightISO(d)).toBe("2026-07-07T00:00:00.000Z");
    expect(nextUtcMidnightISO(d)).toBe("2026-07-08T00:00:00.000Z");
  });
});

describe("effectiveQuotaLimit", () => {
  const defaults = { ...UNLIMITED_QUOTAS, directorTokens: 1000 };

  it("falls back to the default when there's no override", () => {
    expect(effectiveQuotaLimit(null, defaults, "directorTokens")).toBe(1000);
    expect(effectiveQuotaLimit(undefined, defaults, "directorTokens")).toBe(1000);
    expect(effectiveQuotaLimit({}, defaults, "directorTokens")).toBe(1000);
  });

  it("prefers the override when present", () => {
    expect(effectiveQuotaLimit({ directorTokens: 50 }, defaults, "directorTokens")).toBe(50);
  });

  it("an override can grant unlimited (null) even when the default is finite", () => {
    // Storage never holds an explicit null under a key (see applyQuotaOverridesPatch), but this proves
    // effectiveQuotaLimit's `??` still degrades sanely if it ever did.
    expect(effectiveQuotaLimit({ directorTokens: null }, defaults, "directorTokens")).toBe(defaults.directorTokens);
  });

  it("null default with no override is unlimited", () => {
    expect(effectiveQuotaLimit(null, UNLIMITED_QUOTAS, "sttSeconds")).toBeNull();
  });
});

describe("applyQuotaOverridesPatch", () => {
  it("omitted field (undefined) leaves existing overrides unchanged", () => {
    const existing = { sttSeconds: 100 };
    expect(applyQuotaOverridesPatch(existing, undefined)).toBe(existing);
  });

  it("whole-field null clears every override", () => {
    expect(applyQuotaOverridesPatch({ sttSeconds: 100, sunoGens: 5 }, null)).toBeNull();
  });

  it("a per-category null in the patch clears just that category", () => {
    const result = applyQuotaOverridesPatch({ sttSeconds: 100, sunoGens: 5 }, { sttSeconds: null });
    expect(result).toEqual({ sunoGens: 5 });
  });

  it("clearing the only remaining category collapses to null (not {})", () => {
    expect(applyQuotaOverridesPatch({ sttSeconds: 100 }, { sttSeconds: null })).toBeNull();
  });

  it("a numeric value sets/overwrites that category, leaving others untouched", () => {
    const result = applyQuotaOverridesPatch({ sttSeconds: 100 }, { sunoGens: 3 });
    expect(result).toEqual({ sttSeconds: 100, sunoGens: 3 });
  });

  it("starts from null existing + a numeric patch", () => {
    expect(applyQuotaOverridesPatch(null, { directorTokens: 42 })).toEqual({ directorTokens: 42 });
  });
});

describe("QuotaStore / precheckQuota / buildQuotaStatus", () => {
  let db: Database.Database;
  let store: QuotaStore;
  const userId = newId();

  beforeEach(() => {
    db = openDb(":memory:");
    store = new QuotaStore(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function insertUsage(fields: {
    category: string;
    promptTokens?: number;
    completionTokens?: number;
    frames?: number;
    seconds?: number;
    units?: number;
    at?: string;
  }): void {
    db.prepare(
      `INSERT INTO usage_events
         (id, user_id, provider, category, model, prompt_tokens, completion_tokens, cached_tokens,
          frames, seconds, units, actual_cost_usd, upstream_status, at)
       VALUES (@id, @userId, 'openai', @category, NULL, @promptTokens, @completionTokens, NULL,
               @frames, @seconds, @units, NULL, 200, @at)`,
    ).run({
      id: newId(),
      userId,
      category: fields.category,
      promptTokens: fields.promptTokens ?? null,
      completionTokens: fields.completionTokens ?? null,
      frames: fields.frames ?? null,
      seconds: fields.seconds ?? null,
      units: fields.units ?? null,
      at: fields.at ?? new Date().toISOString(),
    });
  }

  it("quotaCategoryFor maps usage categories to their quota bucket", () => {
    expect(quotaCategoryFor("director")).toBe("directorTokens");
    expect(quotaCategoryFor("caption")).toBe("cloudCaptionFrames");
    expect(quotaCategoryFor("stt")).toBe("sttSeconds");
    expect(quotaCategoryFor("music")).toBe("sunoGens");
  });

  it("director usage only counts prompt+completion tokens from 'director' rows, not 'caption' rows", () => {
    insertUsage({ category: "director", promptTokens: 100, completionTokens: 50 });
    insertUsage({ category: "caption", promptTokens: 900, completionTokens: 900 }); // must NOT count
    const used = store.usedSince(userId, "directorTokens", utcMidnightISO());
    expect(used).toBe(150);
  });

  it("only counts rows at/after the UTC-midnight window, ignoring yesterday's usage", () => {
    insertUsage({ category: "stt", seconds: 500, at: "2026-07-06T23:59:59.000Z" }); // yesterday
    insertUsage({ category: "stt", seconds: 20, at: "2026-07-07T00:00:00.000Z" }); // exactly today's boundary
    const used = store.usedSince(userId, "sttSeconds", utcMidnightISO());
    expect(used).toBe(20);
  });

  it("null limit always passes regardless of usage", () => {
    insertUsage({ category: "music", units: 999 });
    const result = precheckQuota(store, userId, "sunoGens", null);
    expect(result.ok).toBe(true);
  });

  it("boundary: used == limit rejects", () => {
    insertUsage({ category: "music", units: 5 });
    const result = precheckQuota(store, userId, "sunoGens", 5);
    expect(result.ok).toBe(false);
    expect(result.used).toBe(5);
  });

  it("boundary: one-under passes", () => {
    insertUsage({ category: "music", units: 4 });
    const result = precheckQuota(store, userId, "sunoGens", 5);
    expect(result.ok).toBe(true);
  });

  it("caption pre-count: rejects when used + this call's frames would reach the limit", () => {
    insertUsage({ category: "caption", frames: 8 });
    const result = precheckQuota(store, userId, "cloudCaptionFrames", 10, /* extraForThisCall */ 2);
    expect(result.ok).toBe(false); // 8 + 2 == 10 -> crosses/reaches the limit
  });

  it("caption pre-count: passes when used + this call's frames stays one under the limit", () => {
    insertUsage({ category: "caption", frames: 8 });
    const result = precheckQuota(store, userId, "cloudCaptionFrames", 10, 1);
    expect(result.ok).toBe(true); // 8 + 1 == 9 < 10
  });

  it("resetsAt is always the next UTC midnight regardless of ok/reject", () => {
    const result = precheckQuota(store, userId, "sunoGens", null);
    expect(result.resetsAt).toBe("2026-07-08T00:00:00.000Z");
  });

  it("buildQuotaStatus reports limit/used/remaining per category and the global resetsAt+killSwitch", () => {
    insertUsage({ category: "stt", seconds: 30 });
    const settings: GlobalSettings = {
      ...DEFAULT_GLOBAL_SETTINGS,
      defaultQuotas: { ...UNLIMITED_QUOTAS, sttSeconds: 100 },
      killSwitch: true,
    };
    const status = buildQuotaStatus(store, settings, userId, null);
    expect(status.killSwitch).toBe(true);
    expect(status.resetsAt).toBe("2026-07-08T00:00:00.000Z");
    expect(status.categories.sttSeconds).toEqual({ limit: 100, used: 30, remaining: 70 });
    expect(status.categories.directorTokens).toEqual({ limit: null, used: 0, remaining: null });
  });

  it("buildQuotaStatus clamps remaining at 0 rather than going negative when over budget", () => {
    insertUsage({ category: "music", units: 12 });
    const settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS, defaultQuotas: { ...UNLIMITED_QUOTAS, sunoGens: 10 } };
    const status = buildQuotaStatus(store, settings, userId, null);
    expect(status.categories.sunoGens).toEqual({ limit: 10, used: 12, remaining: 0 });
  });

  it("a user override beats the global default", () => {
    insertUsage({ category: "music", units: 3 });
    const settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS, defaultQuotas: { ...UNLIMITED_QUOTAS, sunoGens: 10 } };
    const status = buildQuotaStatus(store, settings, userId, { sunoGens: 5 });
    expect(status.categories.sunoGens.limit).toBe(5);
  });
});
