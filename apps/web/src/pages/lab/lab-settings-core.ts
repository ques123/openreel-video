/**
 * Pure LabSettings shape + migration logic, split out of lab-settings.ts so
 * it can be imported WITHOUT pulling the lab's localStorage marker
 * ("openreel:lab-settings", LAB_SETTINGS_KEY below) into a bundle that must
 * never contain it — see apps/web/src/publicflow's bundle rule (WS-E, the
 * wizz.video public product build strips every lab-only marker string).
 *
 * lab-settings.ts re-exports everything here PLUS the localStorage-key
 * constant and load/save helpers, so every existing lab import/test keeps
 * working unchanged. publicflow/preset-runtime.ts imports ONLY from this
 * module: a published preset's `labSettings` JSON blob is validated through
 * the exact same per-field salvager the lab itself uses (a stale/malformed
 * preset can never brick the public app), with zero risk of the admin-only
 * marker leaking into the public bundle.
 *
 * See lab-settings.ts for the full design rationale (why this is one
 * versioned object, why cloud-vision-consent and the director model are
 * deliberately NOT in here, etc.) — this file only carries the parts that
 * moved.
 */

import {
  DEFAULT_SELECTOR_CONFIG,
  type CloudScope,
  type SelectorConfig,
  type SelectorWeights,
  type SharpnessGateMode,
} from "@openreel/core";
import { CAPTION_MODELS, type CaptionModel } from "../../services/cloud-vision";

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
  /**
   * Signal-stack selector tuning surface (weights, gate, chapterGapMinutes,
   * topPerChapter, uniquenessPenalty, keywords) — see signal-score.ts
   * SelectorConfig. Edited by the SignalsPanel tuning UI; the active style
   * preset can still adjust the EFFECTIVE config at selection time
   * (selectorConfigForPreset) without mutating what's stored here.
   */
  selector: SelectorConfig;
  /**
   * Local whisper dials — model checkpoint + VAD speech gate — threaded into
   * usePerceptionLab's TranscriptionRunSettings along with the session-only
   * `cloudEnabled` toggle (NOT persisted, see lab-settings.ts's file header).
   */
  transcription: TranscriptionSettings;
}

/** Persisted local-whisper dials. See LabSettings.transcription. */
export interface TranscriptionSettings {
  localModel: "base" | "large-v3-turbo";
  vad: boolean;
}

/**
 * Deep copy of a SelectorConfig — it nests a weights object, a gate object,
 * and a keywords array, so a shallow spread would still share those with
 * whatever it was copied from. Used to keep every LabSettings instance (and
 * the core DEFAULT_SELECTOR_CONFIG constant itself) from ever sharing
 * mutable state.
 */
export function cloneSelectorConfig(config: SelectorConfig): SelectorConfig {
  return {
    weights: { ...config.weights },
    gate: { ...config.gate },
    chapterGapMinutes: config.chapterGapMinutes,
    topPerChapter: config.topPerChapter,
    uniquenessPenalty: config.uniquenessPenalty,
    keywords: [...config.keywords],
  };
}

/**
 * Defaults favor the cheap path: gpt-5.4-mini captions at comparable quality
 * for ~1/3 the price of gpt-5.2 (measured 91-clip timeline run: $0.55 vs
 * $1.56 — see docs/captioning-cost-plan.md). The flagship is an explicit
 * choice, never the silent reset. Selector defaults are
 * DEFAULT_SELECTOR_CONFIG (signal-score.ts), cloned so no LabSettings
 * instance shares mutable state with the core constant or another instance.
 * Transcription defaults to the small/fast local checkpoint with VAD on
 * (skip non-speech audio — fewer hallucinations, matches
 * DEFAULT_TRANSCRIPTION_SETTINGS in use-perception-lab.ts minus the
 * session-only cloudEnabled field).
 */
export function defaultLabSettings(): LabSettings {
  return {
    version: LAB_SETTINGS_VERSION,
    cloud: {
      scope: "shots",
      model: "gpt-5.4-mini",
      candidatesOnly: null,
    },
    selector: cloneSelectorConfig(DEFAULT_SELECTOR_CONFIG),
    transcription: { localModel: "base", vad: true },
  };
}

/** Finite and non-negative — the shared shape check for every numeric selector field. */
function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function migrateWeights(raw: unknown, defaults: SelectorWeights): SelectorWeights {
  const w = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    motion: isFiniteNonNegative(w.motion) ? w.motion : defaults.motion,
    audio: isFiniteNonNegative(w.audio) ? w.audio : defaults.audio,
    speech: isFiniteNonNegative(w.speech) ? w.speech : defaults.speech,
    aesthetic: isFiniteNonNegative(w.aesthetic) ? w.aesthetic : defaults.aesthetic,
  };
}

function isSharpnessGateMode(v: unknown): v is SharpnessGateMode {
  return v === "exclude" || v === "penalize";
}

function migrateGate(raw: unknown, defaults: SelectorConfig["gate"]): SelectorConfig["gate"] {
  const g = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    minSharpness: isFiniteNonNegative(g.minSharpness) ? g.minSharpness : defaults.minSharpness,
    minShotS: isFiniteNonNegative(g.minShotS) ? g.minShotS : defaults.minShotS,
    sharpnessMode: isSharpnessGateMode(g.sharpnessMode) ? g.sharpnessMode : defaults.sharpnessMode,
    softFocusPenalty: isFiniteNonNegative(g.softFocusPenalty)
      ? g.softFocusPenalty
      : defaults.softFocusPenalty,
  };
}

/** Lowercased/trimmed/deduped strings; a non-array (or non-string entries) fall back to `defaults`. */
function migrateKeywords(raw: unknown, defaults: string[]): string[] {
  if (!Array.isArray(raw)) return [...defaults];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const keyword = item.trim().toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
  }
  return out;
}

/**
 * Per-field selector migration — the same "one stale value never discards
 * the rest" salvaging as `cloud`, one level deeper (weights/gate nest inside
 * selector). topPerChapter additionally requires a positive integer
 * (selectCandidates' per-chapter loop wants a real count, not e.g. 2.5 or 0).
 */
function migrateSelector(raw: unknown): SelectorConfig {
  const defaults = DEFAULT_SELECTOR_CONFIG;
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const topPerChapter =
    typeof s.topPerChapter === "number" &&
    Number.isInteger(s.topPerChapter) &&
    s.topPerChapter >= 1
      ? s.topPerChapter
      : defaults.topPerChapter;
  return {
    weights: migrateWeights(s.weights, defaults.weights),
    gate: migrateGate(s.gate, defaults.gate),
    chapterGapMinutes: isFiniteNonNegative(s.chapterGapMinutes)
      ? s.chapterGapMinutes
      : defaults.chapterGapMinutes,
    topPerChapter,
    uniquenessPenalty: isFiniteNonNegative(s.uniquenessPenalty)
      ? s.uniquenessPenalty
      : defaults.uniquenessPenalty,
    keywords: migrateKeywords(s.keywords, defaults.keywords),
  };
}

/**
 * Per-field transcription migration — same "one stale value never discards
 * the rest" salvaging as `cloud`/`selector`: an invalid localModel or a
 * non-boolean vad falls back independently, so e.g. a hand-edited
 * `{localModel: "large-v3-turbo", vad: "yes"}` keeps the valid model choice.
 */
function migrateTranscription(raw: unknown, defaults: TranscriptionSettings): TranscriptionSettings {
  const t = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    localModel:
      t.localModel === "base" || t.localModel === "large-v3-turbo"
        ? t.localModel
        : defaults.localModel,
    vad: typeof t.vad === "boolean" ? t.vad : defaults.vad,
  };
}

/**
 * Coerce anything previously persisted (or hand-edited, or fetched from the
 * wizz.video preset gateway) into a valid LabSettings: unknown fields are
 * dropped, invalid values fall back to the default PER FIELD (one stale
 * value never discards the rest). Version is currently informational — when
 * v2 lands, add an explicit migration step here keyed on `raw.version`.
 *
 * `selector` and `transcription` were both added under the CURRENT version,
 * deliberately without a bump: each is a purely additive field using the
 * exact same per-field fallback shape `cloud` already has, so a v1 object
 * that predates either just gets `defaults.selector` / `defaults.transcription`
 * — indistinguishable from a v1 object that was missing a `cloud` sub-field.
 * A version bump is for changes that need version-KEYED special-casing (the
 * file's own contract above); "add another optional-shaped field with
 * per-field defaults" isn't that.
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
    selector: migrateSelector((raw as { selector?: unknown }).selector),
    transcription: migrateTranscription(
      (raw as { transcription?: unknown }).transcription,
      defaults.transcription,
    ),
  };
}
