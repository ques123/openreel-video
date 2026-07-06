/**
 * Pure-helper tests for the selector tuning UI: keyword input parsing
 * round-trips, the "tuned vs default" check, and the preset-aware effective
 * config (selectorConfigForPreset wrapped with an explicit "did the preset
 * override anything" flag). Plain vitest, no DOM — same harness pattern as
 * enhance-cost.test.ts / clip-rollup.test.ts.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTOR_CONFIG, type SelectorConfig } from "@openreel/core";
import {
  effectiveSelectorConfig,
  formatKeywordsInput,
  isDefaultSelectorConfig,
  parseKeywordsInput,
} from "./selector-settings";

describe("parseKeywordsInput", () => {
  it("splits on commas, trims, and lowercases", () => {
    expect(parseKeywordsInput(" Birthday , Cake ,party")).toEqual(["birthday", "cake", "party"]);
  });

  it("drops empty entries from stray/trailing commas", () => {
    expect(parseKeywordsInput("cake,, ,party,")).toEqual(["cake", "party"]);
  });

  it("dedupes case/whitespace-insensitively, keeping first-occurrence order", () => {
    expect(parseKeywordsInput("Cake, cake, CAKE , party")).toEqual(["cake", "party"]);
  });

  it("blank/whitespace-only input is an empty array", () => {
    expect(parseKeywordsInput("")).toEqual([]);
    expect(parseKeywordsInput("   ")).toEqual([]);
  });
});

describe("formatKeywordsInput", () => {
  it("joins with a comma-space separator", () => {
    expect(formatKeywordsInput(["cake", "party"])).toBe("cake, party");
  });

  it("round-trips through parseKeywordsInput for already-normalized input", () => {
    const keywords = ["birthday", "cake"];
    expect(parseKeywordsInput(formatKeywordsInput(keywords))).toEqual(keywords);
  });

  it("formats an empty array as an empty string", () => {
    expect(formatKeywordsInput([])).toBe("");
  });
});

describe("isDefaultSelectorConfig", () => {
  it("is true for the shipped defaults, and for a structurally-equal copy", () => {
    expect(isDefaultSelectorConfig(DEFAULT_SELECTOR_CONFIG)).toBe(true);
    expect(
      isDefaultSelectorConfig(JSON.parse(JSON.stringify(DEFAULT_SELECTOR_CONFIG))),
    ).toBe(true);
  });

  it("is false when a top-level field differs", () => {
    expect(
      isDefaultSelectorConfig({
        ...DEFAULT_SELECTOR_CONFIG,
        topPerChapter: DEFAULT_SELECTOR_CONFIG.topPerChapter + 1,
      }),
    ).toBe(false);
  });

  it("is false when a nested weights field differs", () => {
    expect(
      isDefaultSelectorConfig({
        ...DEFAULT_SELECTOR_CONFIG,
        weights: { ...DEFAULT_SELECTOR_CONFIG.weights, motion: 0.99 },
      }),
    ).toBe(false);
  });

  it("is false when a nested gate field differs", () => {
    expect(
      isDefaultSelectorConfig({
        ...DEFAULT_SELECTOR_CONFIG,
        gate: { ...DEFAULT_SELECTOR_CONFIG.gate, sharpnessMode: "penalize" },
      }),
    ).toBe(false);
  });

  it("is false when keywords differ", () => {
    expect(isDefaultSelectorConfig({ ...DEFAULT_SELECTOR_CONFIG, keywords: ["party"] })).toBe(
      false,
    );
  });
});

describe("effectiveSelectorConfig", () => {
  const tunedExclude: SelectorConfig = {
    ...DEFAULT_SELECTOR_CONFIG,
    gate: { ...DEFAULT_SELECTOR_CONFIG.gate, sharpnessMode: "exclude" },
  };

  it("passes the tuned config through unchanged with no preset", () => {
    const result = effectiveSelectorConfig(tunedExclude, null);
    expect(result.config).toEqual(tunedExclude);
    expect(result.presetOverrodeSharpness).toBe(false);
  });

  it("passes through unchanged for a preset that does not allowSoftFocus", () => {
    const result = effectiveSelectorConfig(tunedExclude, { allowSoftFocus: false });
    expect(result.config).toEqual(tunedExclude);
    expect(result.presetOverrodeSharpness).toBe(false);
  });

  it("passes through unchanged when preset is undefined", () => {
    const result = effectiveSelectorConfig(tunedExclude, undefined);
    expect(result.config).toEqual(tunedExclude);
    expect(result.presetOverrodeSharpness).toBe(false);
  });

  it("flips exclude -> penalize for an allowSoftFocus preset and flags the override", () => {
    const result = effectiveSelectorConfig(tunedExclude, { allowSoftFocus: true });
    expect(result.config.gate.sharpnessMode).toBe("penalize");
    expect(result.presetOverrodeSharpness).toBe(true);
  });

  it("does not flag an override when the user already tuned sharpnessMode to penalize", () => {
    const tunedPenalize: SelectorConfig = {
      ...DEFAULT_SELECTOR_CONFIG,
      gate: { ...DEFAULT_SELECTOR_CONFIG.gate, sharpnessMode: "penalize" },
    };
    const result = effectiveSelectorConfig(tunedPenalize, { allowSoftFocus: true });
    expect(result.config.gate.sharpnessMode).toBe("penalize");
    expect(result.presetOverrodeSharpness).toBe(false);
  });

  it("leaves non-gate fields (weights, keywords) untouched by the preset adjustment", () => {
    const tuned: SelectorConfig = { ...tunedExclude, keywords: ["party"], topPerChapter: 9 };
    const result = effectiveSelectorConfig(tuned, { allowSoftFocus: true });
    expect(result.config.keywords).toEqual(["party"]);
    expect(result.config.topPerChapter).toBe(9);
  });
});
