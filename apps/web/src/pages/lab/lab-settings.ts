/**
 * The lab's persisted enhance + selector-tuning settings: ONE versioned,
 * serializable object behind ONE localStorage key, replacing the header's
 * scattered per-control `useState`s. Everything here must stay plain-JSON
 * serializable — this object is the future funnel-preset seam: a named
 * preset is just `{ id, name, settings: LabSettings }` wrapped around this
 * exact shape, so new dials (director promptMode, style preset, selector
 * weights/keywords, target duration) should be added HERE as versioned
 * fields, not as loose page state.
 *
 * That "named preset" seam is now real: wizz.video's PublishedPreset carries
 * a LabSettings-shaped `labSettings` blob (packages/contracts), and the
 * public app validates it through `migrateLabSettings` on every load. The
 * type + migration logic below live in lab-settings-core.ts (a marker-free
 * module — no localStorage, no LAB_SETTINGS_KEY) specifically so
 * apps/web/src/publicflow can import the salvager WITHOUT pulling this
 * file's "openreel:lab-settings" string (a public-bundle grep marker) along
 * with it. Every name below is re-exported unchanged so existing lab
 * imports/tests are unaffected by the split.
 *
 * Deliberately NOT in here:
 * - the cloud-vision consent checkbox — per-session opt-in by design (each
 *   session re-consents to pixels leaving the device);
 * - the cloud-TRANSCRIPTION consent checkbox (cloudEnabled on
 *   TranscriptionRunSettings) — same per-session opt-in convention: audio
 *   leaving the device to Groq re-consents each session, exactly like cloud
 *   vision. Only the local whisper dials (model + VAD) are persisted below;
 * - the director model — already persisted under its own key by
 *   DirectorPanel (openreel:director-model); absorbing it is a later,
 *   separate migration;
 * - bulk-selection overrides — ephemeral run state, not settings.
 */

export {
  cloneSelectorConfig,
  defaultLabSettings,
  LAB_SETTINGS_VERSION,
  migrateLabSettings,
  type CloudEnhanceSettings,
  type LabSettings,
  type TranscriptionSettings,
} from "./lab-settings-core";

import { defaultLabSettings, migrateLabSettings, type LabSettings } from "./lab-settings-core";

export const LAB_SETTINGS_KEY = "openreel:lab-settings";

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
