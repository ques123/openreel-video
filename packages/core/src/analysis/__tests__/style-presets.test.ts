import { describe, expect, it } from "vitest";
import { STYLE_PRESETS, stylePresetById } from "../style-presets";

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("STYLE_PRESETS", () => {
  it("has exactly 11 presets", () => {
    expect(STYLE_PRESETS).toHaveLength(11);
  });

  it("has unique, kebab-case ids", () => {
    const ids = STYLE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(KEBAB_CASE);
    }
  });

  it("has every field non-empty", () => {
    for (const preset of STYLE_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.tagline.length).toBeGreaterThan(0);
      expect(preset.directorNote.length).toBeGreaterThan(0);
      expect(preset.musicHint.length).toBeGreaterThan(0);
    }
  });

  it("marks exactly the soft-friendly presets allowSoftFocus", () => {
    const soft = STYLE_PRESETS.filter((p) => p.allowSoftFocus).map((p) => p.id);
    expect(soft).toEqual(["atmospheric", "cinematic", "memory-film", "visual-poem"]);
    // Punchy/sharp presets keep the hard blurry gate.
    for (const id of ["energetic-vlog", "neistat-vlog", "hype-reel", "social-teaser"]) {
      const preset = STYLE_PRESETS.find((p) => p.id === id);
      expect(preset?.allowSoftFocus).toBeFalsy();
    }
  });
});

describe("stylePresetById", () => {
  it("round-trips every preset id", () => {
    for (const preset of STYLE_PRESETS) {
      expect(stylePresetById(preset.id)).toEqual(preset);
    }
  });

  it("returns null for an unknown id", () => {
    expect(stylePresetById("not-a-real-preset")).toBeNull();
  });

  it("returns null for null or undefined", () => {
    expect(stylePresetById(null)).toBeNull();
    expect(stylePresetById(undefined)).toBeNull();
  });
});
