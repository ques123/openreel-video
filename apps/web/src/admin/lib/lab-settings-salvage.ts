/**
 * Validate-on-save for the Presets editor's labSettings JSON textarea.
 * `PublishedPreset.labSettings` travels as opaque `unknown` on the wire
 * (contracts.ts: "a broken preset can never brick the public app") and the
 * client always runs it through `migrateLabSettings` — the existing
 * per-field salvager (pages/lab/lab-settings.ts, imported READ-ONLY, never
 * edited here). This wraps that call for the admin textarea: unparseable
 * JSON salvages to full defaults exactly like a stale/corrupt localStorage
 * value would, and the caller can show a diff when migration changed
 * anything relative to what was typed.
 */
import { migrateLabSettings, type LabSettings } from "../../pages/lab/lab-settings";

export interface LabSettingsSalvageResult {
  /** The raw parsed input (or `undefined` if the text wasn't valid JSON at all) — for the diff view. */
  before: unknown;
  /** The fully salvaged, valid LabSettings — always safe to save. */
  migrated: LabSettings;
  /** True when `migrated` differs from `before` (some field was invalid/missing and fell back to a default). */
  changed: boolean;
}

export function salvageLabSettingsJson(rawText: string): LabSettingsSalvageResult {
  let before: unknown;
  try {
    before = rawText.trim() ? JSON.parse(rawText) : undefined;
  } catch {
    before = undefined; // unparseable text -> migrateLabSettings(undefined) still returns full, valid defaults
  }
  const migrated = migrateLabSettings(before);
  const changed = JSON.stringify(before) !== JSON.stringify(migrated);
  return { before, migrated, changed };
}
