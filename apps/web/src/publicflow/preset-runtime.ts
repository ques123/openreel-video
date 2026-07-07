/**
 * Loads the active PublishedPreset from the gateway and turns it into a
 * validated PublicRunConfig: labSettings passed through the lab's
 * migrateLabSettings salvager (a stale/malformed preset can never brick the
 * public app), the style whitelist resolved against core STYLE_PRESETS
 * (unknown ids dropped, whitelist order kept), and duration bounds clamped
 * to something sane. Any fetch failure falls back to DEFAULT_PUBLISHED_PRESET
 * EXCEPT `auth_required`, which rethrows so the shell routes to needs-auth
 * (see docs/wizz-contracts.md §7's GenerateFlowState mapping).
 */
import { STYLE_PRESETS } from "@openreel/core";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PUBLISHED_PRESET,
  type FootageCap,
  type PublishedPreset,
} from "@wizz/contracts";
import { migrateLabSettings, type LabSettings } from "../pages/lab/lab-settings-core";
import { getPreset, GatewayError } from "../services/gateway";
import type { PublicRunConfig } from "./types";

/** Sane floor for a target-duration bound — never trust a preset field of 0 or negative. */
const MIN_SANE_DURATION_S = 5;

/**
 * Style chips to render, resolved against core STYLE_PRESETS: unknown ids
 * (a stale whitelist entry from a preset edited against an older catalog)
 * are silently dropped, and the WHITELIST's order is preserved (not
 * STYLE_PRESETS' catalog order) — the admin Presets section curates the
 * display order by editing the whitelist array.
 */
export function resolveStyleWhitelist(
  styleWhitelist: readonly string[],
): { id: string; label: string; tagline: string }[] {
  const byId = new Map(STYLE_PRESETS.map((p) => [p.id, p]));
  const out: { id: string; label: string; tagline: string }[] = [];
  for (const id of styleWhitelist) {
    const preset = byId.get(id);
    if (preset) out.push({ id: preset.id, label: preset.label, tagline: preset.tagline });
  }
  return out;
}

export interface ClampedDurationBounds {
  minTargetS: number;
  maxTargetS: number;
  durationChips: number[];
}

/**
 * Clamp a preset's duration fields into something the bench can safely
 * render: min/max are coerced to finite positive numbers with min <= max
 * (falling back to the shipped defaults when the preset's own fields are
 * unusable), and duration chips are filtered to finite positive values
 * within [min, max] and deduped — an empty result (every chip was garbage or
 * out of range) falls back to the default chip set, itself clamped into the
 * resolved bounds so it can never render a chip below min or above max.
 */
export function clampDurationBounds(preset: PublishedPreset): ClampedDurationBounds {
  const fallback = DEFAULT_PUBLISHED_PRESET;
  const rawMin =
    Number.isFinite(preset.minTargetDurationS) && preset.minTargetDurationS > 0
      ? preset.minTargetDurationS
      : fallback.minTargetDurationS;
  const minTargetS = Math.max(MIN_SANE_DURATION_S, rawMin);
  const rawMax =
    Number.isFinite(preset.maxTargetDurationS) && preset.maxTargetDurationS >= minTargetS
      ? preset.maxTargetDurationS
      : Math.max(minTargetS, fallback.maxTargetDurationS);
  const maxTargetS = Math.max(minTargetS, rawMax);

  const clampChip = (n: number) => Math.min(maxTargetS, Math.max(minTargetS, n));
  const dedupOrdered = (values: number[]): number[] => {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const v of values) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  const validChips = (preset.targetDurationChoicesS ?? []).filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0,
  );
  const inBounds = dedupOrdered(
    validChips.filter((n) => n >= minTargetS && n <= maxTargetS),
  );
  const durationChips =
    inBounds.length > 0
      ? inBounds
      : dedupOrdered(fallback.targetDurationChoicesS.map(clampChip));

  return { minTargetS, maxTargetS, durationChips };
}

/** Safe cast: preset-runtime.ts is the ONLY producer of PublicRunConfig.labSettings, and always assigns a fully-migrated LabSettings here. */
export function labSettingsOf(config: PublicRunConfig): LabSettings {
  return config.labSettings as LabSettings;
}

function buildRunConfig(preset: PublishedPreset, cap: FootageCap): PublicRunConfig {
  const { minTargetS, maxTargetS, durationChips } = clampDurationBounds(preset);
  return {
    preset,
    labSettings: migrateLabSettings(preset.labSettings),
    styles: resolveStyleWhitelist(preset.styleWhitelist ?? []),
    durationChips,
    allowCustomDuration: Boolean(preset.allowCustomDuration),
    minTargetS,
    maxTargetS,
    musicEnabled: Boolean(preset.musicEnabled),
    cloudSTTDefaultOn: Boolean(preset.cloudSTTDefaultOn),
    cap,
  };
}

export async function loadPublicRunConfig(): Promise<PublicRunConfig> {
  try {
    const res = await getPreset();
    return buildRunConfig(res.preset, res.footageCap);
  } catch (err) {
    // auth_required must bubble — the shell routes to the needs-auth scene
    // rather than silently rendering a fallback preset behind a login wall.
    if (err instanceof GatewayError && err.code === "auth_required") throw err;
    console.warn("[publicflow] preset fetch failed, falling back to the default preset:", err);
    return buildRunConfig(DEFAULT_PUBLISHED_PRESET, DEFAULT_GLOBAL_SETTINGS.footageCap);
  }
}
