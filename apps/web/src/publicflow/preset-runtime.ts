/**
 * WS-E IMPLEMENTS THIS (placeholder returns the contract defaults): fetch
 * the active preset via services/gateway.ts getPreset(), pass labSettings
 * through the lab's migrateLabSettings salvager (a stale preset can never
 * brick the app), resolve the style whitelist against core STYLE_PRESETS
 * (unknown ids dropped, whitelist order kept), clamp duration bounds.
 * Falls back to DEFAULT_PUBLISHED_PRESET on any fetch failure EXCEPT
 * auth_required (which must bubble so the shell routes to needs-auth).
 */
import { DEFAULT_PUBLISHED_PRESET, DEFAULT_GLOBAL_SETTINGS } from "@wizz/contracts";
import type { PublicRunConfig } from "./types";

export async function loadPublicRunConfig(): Promise<PublicRunConfig> {
  const preset = DEFAULT_PUBLISHED_PRESET;
  return {
    preset,
    labSettings: null,
    styles: preset.styleWhitelist.map((id) => ({ id, label: id, tagline: "" })),
    durationChips: preset.targetDurationChoicesS,
    allowCustomDuration: preset.allowCustomDuration,
    minTargetS: preset.minTargetDurationS,
    maxTargetS: preset.maxTargetDurationS,
    musicEnabled: preset.musicEnabled,
    cloudSTTDefaultOn: preset.cloudSTTDefaultOn,
    cap: DEFAULT_GLOBAL_SETTINGS.footageCap,
  };
}
