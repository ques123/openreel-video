/**
 * Persisted lab settings: cheap-by-default caption model, one versioned
 * localStorage key, and per-field-salvaging migration (one stale value never
 * discards the rest of the object).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SELECTOR_CONFIG } from "@openreel/core";
import {
  LAB_SETTINGS_KEY,
  LAB_SETTINGS_VERSION,
  cloneSelectorConfig,
  defaultLabSettings,
  loadLabSettings,
  migrateLabSettings,
  saveLabSettings,
  type LabSettings,
} from "./lab-settings";

beforeEach(() => {
  localStorage.clear();
});

describe("defaultLabSettings", () => {
  it("defaults the caption model to gpt-5.4-mini (not the flagship)", () => {
    expect(defaultLabSettings()).toEqual({
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "shots", model: "gpt-5.4-mini", candidatesOnly: null },
      selector: DEFAULT_SELECTOR_CONFIG,
    });
  });

  it("defaults the selector to DEFAULT_SELECTOR_CONFIG", () => {
    expect(defaultLabSettings().selector).toEqual(DEFAULT_SELECTOR_CONFIG);
  });

  it("returns a fresh object each call (no shared mutable default)", () => {
    const a = defaultLabSettings();
    const b = defaultLabSettings();
    expect(a).not.toBe(b);
    expect(a.cloud).not.toBe(b.cloud);
    expect(a.selector).not.toBe(b.selector);
    expect(a.selector).not.toBe(DEFAULT_SELECTOR_CONFIG);
    expect(a.selector.weights).not.toBe(b.selector.weights);
    expect(a.selector.gate).not.toBe(b.selector.gate);
    expect(a.selector.keywords).not.toBe(b.selector.keywords);
  });
});

describe("cloneSelectorConfig", () => {
  it("deep-copies weights, gate, and keywords (no shared references)", () => {
    const clone = cloneSelectorConfig(DEFAULT_SELECTOR_CONFIG);
    expect(clone).toEqual(DEFAULT_SELECTOR_CONFIG);
    expect(clone).not.toBe(DEFAULT_SELECTOR_CONFIG);
    expect(clone.weights).not.toBe(DEFAULT_SELECTOR_CONFIG.weights);
    expect(clone.gate).not.toBe(DEFAULT_SELECTOR_CONFIG.gate);
    expect(clone.keywords).not.toBe(DEFAULT_SELECTOR_CONFIG.keywords);
  });
});

describe("migrateLabSettings", () => {
  it("round-trips a fully valid persisted object", () => {
    const settings = {
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "timeline", model: "gpt-5.2", candidatesOnly: false },
      selector: {
        weights: { motion: 0.4, audio: 0.2, speech: 0.3, aesthetic: 0.1 },
        gate: { minSharpness: 50, minShotS: 1, sharpnessMode: "penalize", softFocusPenalty: 0.4 },
        chapterGapMinutes: 15,
        topPerChapter: 8,
        uniquenessPenalty: 0.2,
        keywords: ["birthday", "cake"],
      },
    };
    expect(migrateLabSettings(settings)).toEqual(settings);
  });

  it("returns defaults for non-object garbage", () => {
    for (const raw of [null, undefined, 42, "settings", true, []]) {
      expect(migrateLabSettings(raw)).toEqual(defaultLabSettings());
    }
  });

  it("salvages per field: one invalid value keeps the rest", () => {
    expect(
      migrateLabSettings({
        version: LAB_SETTINGS_VERSION,
        cloud: { scope: "timeline", model: "gpt-9-imaginary", candidatesOnly: true },
      }),
    ).toEqual({
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "timeline", model: "gpt-5.4-mini", candidatesOnly: true },
      selector: DEFAULT_SELECTOR_CONFIG,
    });
  });

  it("falls back on an invalid scope and a non-boolean candidatesOnly", () => {
    const migrated = migrateLabSettings({
      cloud: { scope: "everything", model: "gpt-5.4-nano", candidatesOnly: "yes" },
    });
    expect(migrated.cloud).toEqual({
      scope: "shots",
      model: "gpt-5.4-nano",
      candidatesOnly: null,
    });
  });

  it("drops unknown fields (persisted shape stays exactly the type)", () => {
    const migrated = migrateLabSettings({
      version: LAB_SETTINGS_VERSION,
      legacyFlag: true,
      cloud: { scope: "shots", model: "gpt-5.2", candidatesOnly: null, extra: 1 },
      selector: { ...DEFAULT_SELECTOR_CONFIG, extra: "nope" },
    });
    expect(Object.keys(migrated).sort()).toEqual(["cloud", "selector", "version"]);
    expect(Object.keys(migrated.cloud).sort()).toEqual(["candidatesOnly", "model", "scope"]);
    expect(Object.keys(migrated.selector).sort()).toEqual([
      "chapterGapMinutes",
      "gate",
      "keywords",
      "topPerChapter",
      "uniquenessPenalty",
      "weights",
    ]);
  });

  describe("selector field", () => {
    it("missing entirely falls back to DEFAULT_SELECTOR_CONFIG", () => {
      expect(migrateLabSettings({ version: LAB_SETTINGS_VERSION }).selector).toEqual(
        DEFAULT_SELECTOR_CONFIG,
      );
    });

    it("a non-object selector (string/number/array) falls back to defaults", () => {
      for (const raw of ["nope", 42, [], null]) {
        expect(migrateLabSettings({ selector: raw }).selector).toEqual(DEFAULT_SELECTOR_CONFIG);
      }
    });

    it("salvages weights per field: one bad weight keeps the other three", () => {
      const selector = migrateLabSettings({
        selector: { weights: { motion: 0.9, audio: -1, speech: "bad", aesthetic: NaN } },
      }).selector;
      expect(selector.weights).toEqual({
        motion: 0.9,
        audio: DEFAULT_SELECTOR_CONFIG.weights.audio,
        speech: DEFAULT_SELECTOR_CONFIG.weights.speech,
        aesthetic: DEFAULT_SELECTOR_CONFIG.weights.aesthetic,
      });
    });

    it("rejects negative/non-finite/non-numeric weights", () => {
      for (const bad of [-0.1, Infinity, -Infinity, NaN, "0.5", null, undefined]) {
        const selector = migrateLabSettings({ selector: { weights: { motion: bad } } }).selector;
        expect(selector.weights.motion).toBe(DEFAULT_SELECTOR_CONFIG.weights.motion);
      }
    });

    it("accepts a valid sharpnessMode and rejects an invalid one", () => {
      expect(
        migrateLabSettings({ selector: { gate: { sharpnessMode: "penalize" } } }).selector.gate
          .sharpnessMode,
      ).toBe("penalize");
      expect(
        migrateLabSettings({ selector: { gate: { sharpnessMode: "blur-everything" } } }).selector
          .gate.sharpnessMode,
      ).toBe(DEFAULT_SELECTOR_CONFIG.gate.sharpnessMode);
    });

    it("salvages gate per field: one bad field keeps its siblings", () => {
      const selector = migrateLabSettings({
        selector: {
          gate: { minSharpness: 60, minShotS: -1, sharpnessMode: "penalize", softFocusPenalty: 0.5 },
        },
      }).selector;
      expect(selector.gate).toEqual({
        minSharpness: 60,
        minShotS: DEFAULT_SELECTOR_CONFIG.gate.minShotS,
        sharpnessMode: "penalize",
        softFocusPenalty: 0.5,
      });
    });

    it("topPerChapter requires a positive integer — non-integer, zero, and negative all fall back", () => {
      for (const bad of [0, -1, 2.5, "6", NaN, Infinity]) {
        expect(migrateLabSettings({ selector: { topPerChapter: bad } }).selector.topPerChapter).toBe(
          DEFAULT_SELECTOR_CONFIG.topPerChapter,
        );
      }
      expect(migrateLabSettings({ selector: { topPerChapter: 12 } }).selector.topPerChapter).toBe(
        12,
      );
    });

    it("rejects negative/non-finite chapterGapMinutes and uniquenessPenalty", () => {
      const selector = migrateLabSettings({
        selector: { chapterGapMinutes: -5, uniquenessPenalty: Infinity },
      }).selector;
      expect(selector.chapterGapMinutes).toBe(DEFAULT_SELECTOR_CONFIG.chapterGapMinutes);
      expect(selector.uniquenessPenalty).toBe(DEFAULT_SELECTOR_CONFIG.uniquenessPenalty);
    });

    it("normalizes keywords: lowercased, trimmed, deduped, non-strings dropped", () => {
      const selector = migrateLabSettings({
        selector: { keywords: [" Cake", "cake", "PARTY ", 42, null, "  "] },
      }).selector;
      expect(selector.keywords).toEqual(["cake", "party"]);
    });

    it("a non-array keywords value falls back to the default (empty) list", () => {
      expect(migrateLabSettings({ selector: { keywords: "cake,party" } }).selector.keywords).toEqual(
        DEFAULT_SELECTOR_CONFIG.keywords,
      );
    });
  });
});

describe("load/save", () => {
  it("loads defaults when nothing is stored", () => {
    expect(loadLabSettings()).toEqual(defaultLabSettings());
  });

  it("round-trips through localStorage under the single key", () => {
    const settings: LabSettings = {
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "timeline", model: "gpt-5.4-nano", candidatesOnly: true },
      selector: { ...DEFAULT_SELECTOR_CONFIG, topPerChapter: 10 },
    };
    saveLabSettings(settings);
    expect(localStorage.getItem(LAB_SETTINGS_KEY)).not.toBeNull();
    expect(loadLabSettings()).toEqual(settings);
  });

  it("survives corrupted stored JSON by returning defaults", () => {
    localStorage.setItem(LAB_SETTINGS_KEY, "{not json");
    expect(loadLabSettings()).toEqual(defaultLabSettings());
  });
});
