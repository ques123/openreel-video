import { describe, expect, it } from "vitest";
import type { UsageRollupRow } from "@wizz/contracts";
import {
  estimatedRowCostUSD,
  estimateRollupSpendUSD,
  resolveDateRangePreset,
  startOfIsoWeekYMD,
  sumUsageRollup,
  toggleUsageGroupBy,
  USAGE_GROUP_BY_DIMENSIONS,
} from "./usage-rollup";

function row(overrides: Partial<UsageRollupRow> = {}): UsageRollupRow {
  return {
    events: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    frames: 0,
    seconds: 0,
    units: 0,
    knownCostUSD: null,
    costedEvents: 0,
    ...overrides,
  };
}

describe("toggleUsageGroupBy", () => {
  it("adds a dimension not yet selected", () => {
    expect(toggleUsageGroupBy([], "day")).toEqual(["day"]);
  });

  it("removes a dimension already selected", () => {
    expect(toggleUsageGroupBy(["day", "provider"], "day")).toEqual(["provider"]);
  });

  it("always returns dimensions in canonical order, regardless of click order", () => {
    let selected = toggleUsageGroupBy([], "category");
    selected = toggleUsageGroupBy(selected, "day");
    selected = toggleUsageGroupBy(selected, "user");
    expect(selected).toEqual(["day", "user", "category"]);
    expect(USAGE_GROUP_BY_DIMENSIONS).toEqual(["day", "user", "provider", "model", "category"]);
  });
});

describe("resolveDateRangePreset", () => {
  const now = new Date("2026-07-07T12:00:00.000Z");

  it("today is a single-day inclusive window", () => {
    expect(resolveDateRangePreset("today", now)).toEqual({ from: "2026-07-07", to: "2026-07-07" });
  });

  it("7d spans the trailing 7 days including today", () => {
    expect(resolveDateRangePreset("7d", now)).toEqual({ from: "2026-07-01", to: "2026-07-07" });
  });

  it("30d spans the trailing 30 days including today", () => {
    expect(resolveDateRangePreset("30d", now)).toEqual({ from: "2026-06-08", to: "2026-07-07" });
  });

  it("custom passes the caller's own range through unchanged", () => {
    expect(resolveDateRangePreset("custom", now, { from: "2026-01-01", to: "2026-01-31" })).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("custom without a supplied range falls back to a today window", () => {
    expect(resolveDateRangePreset("custom", now)).toEqual({ from: "2026-07-07", to: "2026-07-07" });
  });
});

describe("startOfIsoWeekYMD", () => {
  it("returns the same day when now is already Monday", () => {
    expect(startOfIsoWeekYMD(new Date("2026-07-06T09:00:00.000Z"))).toBe("2026-07-06");
  });

  it("returns the preceding Monday mid-week", () => {
    // 2026-07-08 is a Wednesday.
    expect(startOfIsoWeekYMD(new Date("2026-07-08T23:59:00.000Z"))).toBe("2026-07-06");
  });

  it("returns the preceding Monday on a Sunday", () => {
    // 2026-07-12 is a Sunday; its ISO week started Monday 2026-07-06.
    expect(startOfIsoWeekYMD(new Date("2026-07-12T00:00:00.000Z"))).toBe("2026-07-06");
  });
});

describe("sumUsageRollup", () => {
  it("returns all-zero / null-cost totals for an empty result set", () => {
    expect(sumUsageRollup([])).toEqual({
      events: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      frames: 0,
      seconds: 0,
      units: 0,
      knownCostUSD: null,
      costedEvents: 0,
    });
  });

  it("sums plain numeric columns across rows", () => {
    const rows = [
      row({ events: 2, promptTokens: 100, completionTokens: 40, seconds: 30 }),
      row({ events: 3, promptTokens: 200, completionTokens: 10, seconds: 15 }),
    ];
    const totals = sumUsageRollup(rows);
    expect(totals.events).toBe(5);
    expect(totals.promptTokens).toBe(300);
    expect(totals.completionTokens).toBe(50);
    expect(totals.seconds).toBe(45);
  });

  it("sums knownCostUSD only over rows that reported one, ignoring null rows", () => {
    const rows = [
      row({ events: 3, knownCostUSD: 0.01, costedEvents: 2 }),
      row({ events: 2, knownCostUSD: null, costedEvents: 0 }),
    ];
    const totals = sumUsageRollup(rows);
    expect(totals.knownCostUSD).toBeCloseTo(0.01);
    expect(totals.costedEvents).toBe(2);
    expect(totals.events).toBe(5);
  });

  it("total knownCostUSD is null when NOT ONE row ever reported a cost (never $0)", () => {
    const rows = [row({ events: 4, knownCostUSD: null }), row({ events: 1, knownCostUSD: null })];
    expect(sumUsageRollup(rows).knownCostUSD).toBeNull();
  });
});

describe("estimated spend (dollarizes OpenAI director cost that never reports a bill)", () => {
  it("estimatedRowCostUSD: OpenAI director row estimated from tokens (no provider bill)", () => {
    // 20061 prompt (37504 cached across the run — use a representative subset) + 234 completion on mini.
    const r = row({
      events: 2,
      model: "gpt-5.4-mini",
      promptTokens: 20061,
      completionTokens: 234,
      cachedTokens: 15000,
      knownCostUSD: null,
      costedEvents: 0,
    });
    const est = estimatedRowCostUSD(r);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(0.002); // meaningfully non-zero, unlike the STT-only $0.0003 the raw sum showed
  });

  it("estimatedRowCostUSD: prefers the exact provider bill when every event reported one", () => {
    const r = row({ events: 3, model: "qwen/qwen3-vl-30b-a3b-instruct", knownCostUSD: 0.0000053, costedEvents: 3 });
    expect(estimatedRowCostUSD(r)).toBe(0.0000053);
  });

  it("estimatedRowCostUSD: unpriceable (Suno units, no token model) -> null", () => {
    expect(estimatedRowCostUSD(row({ events: 2, model: null, units: 2, knownCostUSD: null }))).toBeNull();
  });

  it("estimateRollupSpendUSD: sums exact + estimate and counts unpriceable events", () => {
    const rows = [
      row({ events: 2, model: "gpt-5.4-mini", promptTokens: 20000, completionTokens: 200, cachedTokens: 15000 }),
      row({ events: 3, model: "qwen/qwen3-vl-30b-a3b-instruct", knownCostUSD: 0.0002, costedEvents: 3 }),
      row({ events: 2, model: null, units: 2, knownCostUSD: null }), // suno — unpriceable
    ];
    const spend = estimateRollupSpendUSD(rows);
    expect(spend.totalUSD).toBeGreaterThan(0.0002); // includes the director estimate, not just the exact $0.0002
    expect(spend.hasEstimate).toBe(true);
    expect(spend.unpriceableEvents).toBe(2);
  });
});
