/**
 * Pure logic of the experiments service: the eviction-cap warning threshold,
 * the JSON export payload shape (what it includes and what it deliberately
 * leaves out), the picker filter, and the cost line's cached-token discount
 * plus aux-usage (brief suggestions / music brief) inclusion.
 */

import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_CAP_WARN_AT,
  MAX_EXPERIMENTS,
  buildExperimentsExport,
  evictionWarning,
  experimentAuxCostUSD,
  experimentAuxUsage,
  experimentCostLine,
  matchesExperimentFilter,
  type DirectorExperiment,
} from "./experiments";
import { estimateCostUSD, fmtUSD } from "./model-pricing";

describe("evictionWarning", () => {
  it("stays silent comfortably under the cap", () => {
    expect(evictionWarning(0)).toBeNull();
    expect(evictionWarning(120)).toBeNull();
    expect(evictionWarning(EXPERIMENT_CAP_WARN_AT - 1)).toBeNull();
  });

  it("warns from the threshold up, quoting count/cap", () => {
    const warn = evictionWarning(EXPERIMENT_CAP_WARN_AT);
    expect(warn).toContain(`${EXPERIMENT_CAP_WARN_AT}/${MAX_EXPERIMENTS}`);
    expect(warn).toMatch(/deleted/i);
    expect(warn).toMatch(/export/i);
  });

  it("switches to present tense at/past the cap (eviction is happening NOW)", () => {
    for (const count of [MAX_EXPERIMENTS, MAX_EXPERIMENTS + 3]) {
      const warn = evictionWarning(count);
      expect(warn).toContain(`${count}/${MAX_EXPERIMENTS}`);
      expect(warn).toMatch(/every new run permanently deletes/i);
    }
  });
});

describe("matchesExperimentFilter", () => {
  const summary = {
    brief: "A calm sunset montage over the bay",
    title: "Golden Hour",
    model: "gpt-5.2",
    captionModels: "gpt-5.4-mini",
    briefAngle: "atmosphere",
  };

  it("matches all on a blank/whitespace query", () => {
    expect(matchesExperimentFilter(summary, "")).toBe(true);
    expect(matchesExperimentFilter(summary, "   ")).toBe(true);
  });

  it("matches case-insensitive substrings of brief / title / models / angle", () => {
    expect(matchesExperimentFilter(summary, "SUNSET")).toBe(true);
    expect(matchesExperimentFilter(summary, "golden")).toBe(true);
    expect(matchesExperimentFilter(summary, "5.2")).toBe(true);
    expect(matchesExperimentFilter(summary, "5.4-mini")).toBe(true);
    expect(matchesExperimentFilter(summary, "atmos")).toBe(true);
  });

  it("rejects non-matches and tolerates absent optional fields", () => {
    expect(matchesExperimentFilter(summary, "drone footage")).toBe(false);
    expect(
      matchesExperimentFilter({ brief: "b", title: null, model: "m" }, "anything"),
    ).toBe(false);
    expect(matchesExperimentFilter({ brief: "b", title: null, model: "m" }, "b")).toBe(true);
  });
});

function makeExperiment(overrides: Partial<DirectorExperiment> = {}): DirectorExperiment {
  return {
    id: "exp-test",
    at: 1,
    updatedAt: 2,
    brief: "test brief",
    targetDurationS: null,
    promptSources: {} as DirectorExperiment["promptSources"],
    model: "gpt-5.2",
    captionModels: "local-only",
    clips: [],
    messages: [],
    activity: [],
    storyboard: null,
    warnings: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    durationMs: 0,
    ...overrides,
  };
}

describe("buildExperimentsExport", () => {
  it("wraps full records and declares what is excluded (rendered videos)", () => {
    const exps = [makeExperiment({ id: "a" }), makeExperiment({ id: "b" })];
    const before = Date.now();
    const payload = buildExperimentsExport(exps);
    expect(payload.kind).toBe("openreel-director-experiments");
    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toBeGreaterThanOrEqual(before);
    expect(payload.experiments).toHaveLength(2);
    expect(payload.experiments[0].id).toBe("a");
    expect(payload.excludes).toMatch(/video/i);
    // Records go out verbatim — the payload must survive a JSON round-trip.
    const parsed = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(parsed.experiments[1].brief).toBe("test brief");
  });
});

describe("experimentCostLine — cached tokens", () => {
  const base = {
    model: "gpt-5.2",
    promptTokens: 1_000_000,
    completionTokens: 10_000,
  };

  it("passes cachedTokens into the price and renders them subtly", () => {
    const line = experimentCostLine({ ...base, cachedTokens: 800_000 });
    expect(line).toContain("(800k cached)");
    const expected = estimateCostUSD("gpt-5.2", 1_000_000, 10_000, 800_000)!;
    expect(line).toContain(`≈${fmtUSD(expected)}`);
    // The discount must actually bite: cached < uncached.
    const uncached = estimateCostUSD("gpt-5.2", 1_000_000, 10_000, 0)!;
    expect(expected).toBeLessThan(uncached);
    expect(line).not.toContain(`≈${fmtUSD(uncached)}`);
  });

  it("omits the cached marker when nothing was cached", () => {
    expect(experimentCostLine(base)).not.toContain("cached");
    expect(experimentCostLine({ ...base, cachedTokens: 0 })).not.toContain("cached");
  });
});

describe("experimentCostLine — actual (billed) director cost", () => {
  const base = {
    model: "qwen/qwen3.7-max",
    promptTokens: 1_000_000,
    completionTokens: 10_000,
  };

  it("prefers the exact billed costUSD (plain $, no tilde) when complete", () => {
    const line = experimentCostLine({ ...base, costUSD: 0.204 });
    expect(line).toContain("$0.20");
    expect(line).not.toContain("≈$0.20");
    // The exact figure wins even though it differs from the floor-rate
    // estimate — this is the whole point (OpenRouter can bill above it).
    const estimate = estimateCostUSD(base.model, base.promptTokens, base.completionTokens)!;
    expect(line).not.toContain(`≈${fmtUSD(estimate)}`);
  });

  it("falls back to the ≈ token×rate estimate when costUSDIncomplete is set", () => {
    const line = experimentCostLine({ ...base, costUSD: 0.05, costUSDIncomplete: true });
    const estimate = estimateCostUSD(base.model, base.promptTokens, base.completionTokens)!;
    expect(line).toContain(`≈${fmtUSD(estimate)}`);
    expect(line).not.toContain("$0.05");
  });

  it("falls back to the ≈ estimate when costUSD was never recorded (OpenAI models, legacy runs)", () => {
    const line = experimentCostLine(base);
    const estimate = estimateCostUSD(base.model, base.promptTokens, base.completionTokens)!;
    expect(line).toContain(`≈${fmtUSD(estimate)}`);
  });
});

describe("experimentCostLine — aux usage", () => {
  it("appends aux tokens and cost when present", () => {
    const aux = [
      { model: "gpt-5.4-mini", promptTokens: 20_000, completionTokens: 1_000, cachedTokens: 0 },
    ];
    const line = experimentCostLine({ model: "gpt-5.2", auxUsage: aux });
    expect(line).toContain("aux 21k tok");
    const expected = estimateCostUSD("gpt-5.4-mini", 20_000, 1_000, 0)!;
    expect(line).toContain(`≈${fmtUSD(expected)}`);
  });

  it("shows aux tokens without a price for unknown models", () => {
    const aux = [
      { model: "some/unknown-model", promptTokens: 5_000, completionTokens: 500, cachedTokens: 0 },
    ];
    const line = experimentCostLine({ model: "gpt-5.2", auxUsage: aux })!;
    expect(line).toContain("aux 5.5k tok");
    expect(line.slice(line.indexOf("aux"))).not.toContain("≈");
  });

  it("omits the aux part entirely when there is none", () => {
    expect(experimentCostLine({ model: "gpt-5.2", promptTokens: 100 })).not.toContain("aux");
  });
});

describe("experimentAuxUsage / experimentAuxCostUSD", () => {
  it("merges auxUsage with the music-brief call", () => {
    const music = { model: "gpt-5.4-mini", promptTokens: 1, completionTokens: 2, cachedTokens: 0 };
    const listed = { model: "gpt-5.2", promptTokens: 3, completionTokens: 4, cachedTokens: 0 };
    expect(experimentAuxUsage({ auxUsage: [listed], music: { usage: music } })).toEqual([
      listed,
      music,
    ]);
    expect(experimentAuxUsage({})).toEqual([]);
  });

  it("prices what it can and returns null when nothing is priceable", () => {
    expect(experimentAuxCostUSD([])).toBeNull();
    expect(
      experimentAuxCostUSD([
        { model: "no-such-model", promptTokens: 10, completionTokens: 10, cachedTokens: 0 },
      ]),
    ).toBeNull();
    const known = {
      model: "gpt-5.4-mini",
      promptTokens: 100_000,
      completionTokens: 0,
      cachedTokens: 0,
    };
    expect(experimentAuxCostUSD([known])).toBeCloseTo(
      estimateCostUSD("gpt-5.4-mini", 100_000, 0, 0)!,
      10,
    );
  });
});
