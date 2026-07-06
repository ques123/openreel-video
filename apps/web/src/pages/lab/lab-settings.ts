/**
 * The lab's persisted enhance settings: ONE versioned, serializable object
 * behind ONE localStorage key, replacing the header's scattered per-control
 * `useState`s. Everything here must stay plain-JSON serializable — this
 * object is the future funnel-preset seam: a named preset is just
 * `{ id, name, settings: LabSettings }` wrapped around this exact shape, so
 * new dials (director promptMode, style preset, selector weights/keywords,
 * target duration) should be added HERE as versioned fields, not as loose
 * page state.
 *
 * Deliberately NOT in here:
 * - the cloud-vision consent checkbox — per-session opt-in by design (each
 *   session re-consents to pixels leaving the device);
 * - the director model — already persisted under its own key by
 *   DirectorPanel (openreel:director-model); absorbing it is a later,
 *   separate migration;
 * - bulk-selection overrides — ephemeral run state, not settings.
 */

import type { CloudScope } from "@openreel/core";
import { CAPTION_MODELS, type CaptionModel } from "../../services/cloud-vision";

export const LAB_SETTINGS_KEY = "openreel:lab-settings";
export const LAB_SETTINGS_VERSION = 1;

/** Dials for a cloud enhance run (what gets sent, and to which model). */
export interface CloudEnhanceSettings {
  /** How much to send per enhance: one frame per shot, or the full sampled timeline. */
  scope: CloudScope;
  /** Caption model for enhance runs. */
  model: CaptionModel;
  /**
   * Restrict enhance to the selector's candidate shots. null = auto: on as
   * soon as candidates exist (the selector's whole point is to stop sending
   * everything), off before that.
   */
  candidatesOnly: boolean | null;
}

export interface LabSettings {
  version: typeof LAB_SETTINGS_VERSION;
  cloud: CloudEnhanceSettings;
}

/**
 * Defaults favor the cheap path: gpt-5.4-mini captions at comparable quality
 * for ~1/3 the price of gpt-5.2 (measured 91-clip timeline run: $0.55 vs
 * $1.56 — see docs/captioning-cost-plan.md). The flagship is an explicit
 * choice, never the silent reset.
 */
export function defaultLabSettings(): LabSettings {
  return {
    version: LAB_SETTINGS_VERSION,
    cloud: {
      scope: "shots",
      model: "gpt-5.4-mini",
      candidatesOnly: null,
    },
  };
}

/**
 * Coerce anything previously persisted (or hand-edited) into a valid
 * LabSettings: unknown fields are dropped, invalid values fall back to the
 * default PER FIELD (one stale value never discards the rest). Version is
 * currently informational — when v2 lands, add an explicit migration step
 * here keyed on `raw.version`.
 */
export function migrateLabSettings(raw: unknown): LabSettings {
  const defaults = defaultLabSettings();
  if (!raw || typeof raw !== "object") return defaults;
  const cloudRaw = (raw as { cloud?: unknown }).cloud;
  const cloud =
    cloudRaw && typeof cloudRaw === "object" ? (cloudRaw as Record<string, unknown>) : {};
  return {
    version: LAB_SETTINGS_VERSION,
    cloud: {
      scope: cloud.scope === "timeline" || cloud.scope === "shots" ? cloud.scope : defaults.cloud.scope,
      model:
        typeof cloud.model === "string" &&
        (CAPTION_MODELS as readonly string[]).includes(cloud.model)
          ? (cloud.model as CaptionModel)
          : defaults.cloud.model,
      candidatesOnly:
        typeof cloud.candidatesOnly === "boolean" ? cloud.candidatesOnly : null,
    },
  };
}

/** Load the persisted settings; any storage/parse failure returns defaults. */
export function loadLabSettings(): LabSettings {
  try {
    const raw = localStorage.getItem(LAB_SETTINGS_KEY);
    if (!raw) return defaultLabSettings();
    return migrateLabSettings(JSON.parse(raw));
  } catch {
    return defaultLabSettings();
  }
}

/** Persist the settings; best-effort (private browsing/quota just no-ops). */
export function saveLabSettings(settings: LabSettings): void {
  try {
    localStorage.setItem(LAB_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // The dials still work this session.
  }
}
