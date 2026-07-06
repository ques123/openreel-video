/**
 * Pure helpers behind the signal-stack selector tuning UI (SignalsPanel's
 * "tune" panel): keyword-input parsing/formatting, the "has this been
 * changed from the defaults" check driving the panel's "tuned" indicator,
 * and the preset-aware effective config (wraps signal-score.ts's
 * selectorConfigForPreset, plus whether the preset actually changed
 * anything) so the UI can explain a visible "exclude" setting that doesn't
 * behave like one. No React, no I/O — everything here is unit-tested.
 */

import {
  DEFAULT_SELECTOR_CONFIG,
  selectorConfigForPreset,
  type SelectorConfig,
  type StylePreset,
} from "@openreel/core";

/**
 * Comma-separated keywords input -> the normalized array signal-score.ts
 * expects: lowercased, trimmed, empties dropped, duplicates removed (first
 * occurrence wins the surviving order).
 */
export function parseKeywordsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const keyword = part.trim().toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
  }
  return out;
}

/** Inverse of parseKeywordsInput, for seeding the text input from stored config. */
export function formatKeywordsInput(keywords: string[]): string {
  return keywords.join(", ");
}

/**
 * True when `config` is field-for-field identical to the shipped defaults —
 * drives the SignalsPanel "tuned" indicator. Compares the user's SAVED
 * config, not a preset-adjusted effective one: a style preset silently
 * flipping sharpnessMode shouldn't itself read as "the user tuned this".
 */
export function isDefaultSelectorConfig(config: SelectorConfig): boolean {
  return JSON.stringify(config) === JSON.stringify(DEFAULT_SELECTOR_CONFIG);
}

export interface EffectiveSelectorConfig {
  /** What selectCandidates should actually run with. */
  config: SelectorConfig;
  /**
   * True when the active style preset's allowSoftFocus converted the tuned
   * config's "exclude" sharpness gate into "penalize" (selectorConfigForPreset)
   * — i.e. the effective mode differs from what the user actually set.
   */
  presetOverrodeSharpness: boolean;
}

/**
 * The config selection should run with right now: the user's tuned config,
 * adjusted for the active style preset (selectorConfigForPreset) — plus
 * whether that adjustment actually changed anything, so the tuning UI can
 * show a hint explaining a visible "exclude" setting that behaves like
 * "penalize" because of the preset.
 */
export function effectiveSelectorConfig(
  tuned: SelectorConfig,
  preset: Pick<StylePreset, "allowSoftFocus"> | null | undefined,
): EffectiveSelectorConfig {
  const config = selectorConfigForPreset(preset, tuned);
  return {
    config,
    presetOverrodeSharpness: config.gate.sharpnessMode !== tuned.gate.sharpnessMode,
  };
}
