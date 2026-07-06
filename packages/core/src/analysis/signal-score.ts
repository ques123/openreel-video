/**
 * Signal-stack shot scoring, chapter segmentation, and candidate selection —
 * the "selector": how a human editor skims everything fast, logs selects,
 * and picks the best moment from each part of the day instead of a global
 * greatest-hits top-K.
 *
 * Everything here is pure and deterministic over ClipDossiers already in
 * memory (motion, sharpness, embeddings, transcript, audio events) — no
 * model calls, no I/O — so the exact selection the director sees is
 * reproducible and unit-tested.
 */

import type { ClipDossier, Shot } from "./types";

export interface SelectorWeights {
  /** Shot motion score (normalized within the footage set). */
  motion: number;
  /** Audio event overlap/intensity within the shot. */
  audio: number;
  /** Speech presence + keyword hits from the transcript. */
  speech: number;
  /** Sharpness-based aesthetic tiebreak (normalized within the set). */
  aesthetic: number;
}

export interface SelectorConfig {
  weights: SelectorWeights;
  /** Shots failing these are gated out before scoring (reason recorded). */
  gate: {
    /** Laplacian variance floor for the shot's rep frame. */
    minSharpness: number;
    /** Minimum shot duration, seconds. */
    minShotS: number;
  };
  /** recordedAt gap between consecutive clips that starts a new chapter, minutes. */
  chapterGapMinutes: number;
  /** Candidates to pick per chapter (before uniqueness pruning). */
  topPerChapter: number;
  /**
   * Uniqueness: a candidate's final score is composite − penalty × its max
   * embedding cosine to already-picked shots. 0 disables.
   */
  uniquenessPenalty: number;
  /** Transcript words (lowercase) that boost the speech component when present. */
  keywords: string[];
}

export const DEFAULT_SELECTOR_CONFIG: SelectorConfig = {
  weights: { motion: 0.3, audio: 0.3, speech: 0.25, aesthetic: 0.15 },
  gate: { minSharpness: 40, minShotS: 0.8 },
  chapterGapMinutes: 25,
  topPerChapter: 6,
  uniquenessPenalty: 0.35,
  keywords: [],
};

/** Per-component contributions, each normalized to 0..1 across the footage set. */
export interface ShotScoreComponents {
  motion: number;
  audio: number;
  speech: number;
  aesthetic: number;
}

export interface ShotScore {
  clipId: string;
  fileName: string;
  shotIndex: number;
  /** True when the technical gate rejected the shot (components still filled for the UI). */
  gated: boolean;
  /** Human-readable gate reasons, e.g. "blurry (sharpness 12 < 40)". */
  gateReasons: string[];
  components: ShotScoreComponents;
  /** Weighted composite of components, 0..1. */
  score: number;
}

/** A contiguous stretch of the footage set — recordedAt-gap segmentation. */
export interface Chapter {
  index: number;
  /** Dossier clipIds in recording order. */
  clipIds: string[];
  /** recordedAt of the chapter's first clip (epoch ms), null when unknown. */
  startedAt: number | null;
  /** Short UI label, e.g. "ch 2 · 14:05–14:38 UTC · 3 clips". */
  label: string;
}

export interface CandidatePick {
  clipId: string;
  fileName: string;
  shotIndex: number;
  chapterIndex: number;
  /** 1-based rank within the chapter. */
  rank: number;
  /** Composite score after the uniqueness penalty that applied at pick time. */
  finalScore: number;
  /** Cosine-to-picked penalty that was subtracted (0 for the first picks). */
  uniquenessPenalty: number;
  /** Short human-readable why, e.g. "loud moment (z 4.1) + high motion". */
  reasons: string[];
}

export interface SelectionResult {
  config: SelectorConfig;
  chapters: Chapter[];
  /** Every shot in the set, scored (gated ones included, for the UI). */
  scores: ShotScore[];
  /** Picks ordered by chapter then rank. */
  picks: CandidatePick[];
}

/**
 * Group clips into chapters by recordedAt gaps (> chapterGapMinutes starts a
 * new chapter). Clips are considered in recording order; clips with null
 * recordedAt go into a single trailing "unknown time" chapter. One clip =
 * one chapter set of [that clip]; empty input = [].
 */
export function segmentChapters(
  dossiers: ClipDossier[],
  config: SelectorConfig = DEFAULT_SELECTOR_CONFIG,
): Chapter[] {
  void dossiers; void config;
  throw new Error("not implemented");
}

/**
 * Score every shot of every dossier. Component normalization (motion,
 * aesthetic) is across ALL passed dossiers so scores are comparable
 * set-wide. Audio component: overlap with dossier.audioEvents scaled by
 * intensity (0 when the clip has no audio signals yet). Speech component:
 * fraction of the shot covered by transcript segments, boosted to 1 when a
 * config keyword appears in an overlapping segment.
 */
export function scoreShots(
  dossiers: ClipDossier[],
  config: SelectorConfig = DEFAULT_SELECTOR_CONFIG,
): ShotScore[] {
  void dossiers; void config;
  throw new Error("not implemented");
}

/**
 * Full selection: segment chapters, score shots, then per chapter greedily
 * pick up to topPerChapter ungated shots by composite score minus the
 * uniqueness penalty (max cosine of the shot's rep embedding to ALL
 * already-picked shots across chapters; shots without embeddings get no
 * penalty). Fewer ungated shots than topPerChapter → pick what exists.
 */
export function selectCandidates(
  dossiers: ClipDossier[],
  config: SelectorConfig = DEFAULT_SELECTOR_CONFIG,
): SelectionResult {
  void dossiers; void config;
  throw new Error("not implemented");
}

/** Convenience: picks for one clip, sorted by shot index (filmstrip badges). */
export function picksForClip(
  selection: SelectionResult,
  clipId: string,
): CandidatePick[] {
  void selection; void clipId;
  throw new Error("not implemented");
}

/** The shot a pick refers to, or null when the dossier/shot is missing. */
export function pickShot(
  dossiers: ClipDossier[],
  pick: CandidatePick,
): Shot | null {
  void dossiers; void pick;
  throw new Error("not implemented");
}
