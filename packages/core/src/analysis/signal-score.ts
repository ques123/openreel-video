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

import { similarCaptions } from "./caption-text";
import { dot } from "./shot-metrics";
import type { StylePreset } from "./style-presets";
import type { AudioEvent, ClipDossier, Shot, TranscriptSegment } from "./types";

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

/**
 * What happens to a shot whose sharpness falls below gate.minSharpness:
 * - "exclude": hard gate — the shot can never be picked (standard presets).
 * - "penalize": the shot stays a candidate but its composite score is docked
 *   by up to gate.softFocusPenalty, linear in the shortfall — soft/artistic
 *   frames (mist, shallow focus, motion blur) survive for presets that want
 *   them (see selectorConfigForPreset / StylePreset.allowSoftFocus).
 */
export type SharpnessGateMode = "exclude" | "penalize";

/**
 * The full tuning surface of the selector — everything a tuning UI would
 * bind to. Every field is honored by selectCandidates (and the pieces it
 * delegates to: segmentChapters, scoreShots).
 */
export interface SelectorConfig {
  weights: SelectorWeights;
  /** Shots failing these are gated out before scoring (reason recorded). */
  gate: {
    /** Laplacian variance floor for the shot's rep frame. */
    minSharpness: number;
    /** Minimum shot duration, seconds. Always a hard gate. */
    minShotS: number;
    /** How a below-minSharpness shot is treated (see SharpnessGateMode). */
    sharpnessMode: SharpnessGateMode;
    /**
     * Max composite-score deduction in "penalize" mode (applied in full at
     * sharpness 0, scaling linearly to 0 at minSharpness). Composite scores
     * live in 0..1, so 0.25 means a fully-blurry shot must beat sharp rivals
     * by a quarter of the scale on its other signals. Unused in "exclude".
     */
    softFocusPenalty: number;
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
  gate: { minSharpness: 40, minShotS: 0.8, sharpnessMode: "exclude", softFocusPenalty: 0.25 },
  chapterGapMinutes: 25,
  topPerChapter: 6,
  uniquenessPenalty: 0.35,
  keywords: [],
};

/**
 * Preset-aware selector config: presets that embrace soft/artistic frames
 * (StylePreset.allowSoftFocus) get the blurry hard-gate converted into a
 * scoring penalty so deliberately soft shots stay candidates; every other
 * preset (and no preset) keeps `base` unchanged.
 */
export function selectorConfigForPreset(
  preset: Pick<StylePreset, "allowSoftFocus"> | null | undefined,
  base: SelectorConfig = DEFAULT_SELECTOR_CONFIG,
): SelectorConfig {
  if (!preset?.allowSoftFocus) return base;
  if (base.gate.sharpnessMode === "penalize") return base;
  return { ...base, gate: { ...base.gate, sharpnessMode: "penalize" } };
}

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
  /**
   * Composite-score deduction applied because the shot fell below
   * minSharpness in "penalize" mode — already subtracted from `score`,
   * recorded so the UI can explain the shot's rank. 0 (or absent, for
   * hand-built fixtures) when no penalty applied.
   */
  softPenalty?: number;
  /** Weighted composite of components (minus softPenalty), 0..1. */
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

// ---------------------------------------------------------------------------
// sharpness pipeline buckets
// ---------------------------------------------------------------------------

/**
 * Sharpness (Laplacian variance) is measured on ~512px scan frames, but the
 * pixels arriving at 512px depend on the pipeline that produced them. A DJI
 * .LRF proxy is ~720p, heavily compressed, and only mildly downscaled to
 * 512 (~1.4×) — codec smoothing survives the resize and Laplacian variances
 * read systematically LOWER than the same scene analyzed from a 1080p/4K
 * original, whose aggressive downscale (~4–8×) steepens edges and averages
 * noise. Judging both buckets with one constant over-rejects proxy-analyzed
 * footage, so proxy-bucket values are re-expressed on the full-res scale by
 * this factor before gating and normalization. The full-res bucket uses
 * scale 1 (behavior there is bit-identical to before). The magnitude is a
 * considered estimate, NOT a measurement — revisit with paired LRF/original
 * footage when available.
 */
export const PROXY_SHARPNESS_SCALE = 1.6;

/** The shot's sharpness on the full-res scale (see PROXY_SHARPNESS_SCALE). */
function bucketSharpness(dossier: ClipDossier, shot: Shot): number {
  return dossier.analyzedFromProxy
    ? shot.quality.sharpness * PROXY_SHARPNESS_SCALE
    : shot.quality.sharpness;
}

// ---------------------------------------------------------------------------
// transcript hallucination collapse
// ---------------------------------------------------------------------------

/**
 * Coverage weight for a transcript segment that near-duplicates the segment
 * that started its run. Whisper hallucination loops (wind noise, silence →
 * the same phrase over and over) would otherwise count as wall-to-wall
 * speech and turn junk into a ★ pick "why: speech". Non-zero because real
 * speakers do repeat themselves once or twice — a single echo costs little,
 * a 20× loop collapses to almost nothing.
 */
export const REPEATED_SPEECH_WEIGHT = 0.15;

/**
 * Per-segment coverage weights for speech scoring, aligned by index with
 * `transcript`: 1 for the first segment of a run of near-duplicate texts,
 * REPEATED_SPEECH_WEIGHT for each repeat. "Near-duplicate" is the same
 * word-set Jaccard used to merge dense captions (caption-text.ts), so
 * punctuation/filler variations still collapse while real varied speech is
 * untouched. A genuinely new phrase starts a fresh run (weight 1).
 */
export function transcriptSpeechWeights(transcript: TranscriptSegment[]): number[] {
  const weights: number[] = new Array(transcript.length);
  let exemplar: string | null = null;
  for (let i = 0; i < transcript.length; i += 1) {
    const text = transcript[i].text;
    if (exemplar !== null && similarCaptions(exemplar, text)) {
      weights[i] = REPEATED_SPEECH_WEIGHT;
    } else {
      weights[i] = 1;
      exemplar = text;
    }
  }
  return weights;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/** Clamped overlap (seconds) between two intervals; 0 when disjoint. */
function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * "95th percentile" via nearest-rank on the sorted array, rounding the rank
 * DOWN (`floor(p * (n-1))`). This — rather than linear interpolation, which
 * would blend the second-highest value with the outlier itself — is what
 * keeps a single extreme outlier from dragging the normalization denominator
 * (and therefore every other shot's normalized score) toward it: with a
 * handful of points the flooring lands one rank below the max whenever the
 * outlier is the single largest value.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** value / p95, clamped to [0, 1]; 0 when p95 is non-positive (no signal at all). */
function normalize(value: number, p95: number): number {
  if (p95 <= 0) return 0;
  return Math.min(1, value / p95);
}

/** The overlapping audio event with the highest intensity, plus its overlap duration. */
function findMaxAudioEvent(
  shot: Shot,
  events: AudioEvent[] | undefined,
): { event: AudioEvent; overlapS: number } | null {
  if (!events || events.length === 0) return null;
  let best: { event: AudioEvent; overlapS: number } | null = null;
  for (const event of events) {
    const overlapS = overlapSeconds(shot.tStart, shot.tEnd, event.t, event.t + event.durS);
    if (overlapS <= 0) continue;
    if (!best || event.intensity > best.event.intensity) {
      best = { event, overlapS };
    }
  }
  return best;
}

/** The first overlapping transcript segment that contains a config keyword. */
function findKeywordMatch(
  shot: Shot,
  transcript: TranscriptSegment[],
  keywords: string[],
): { segment: TranscriptSegment; keyword: string } | null {
  if (keywords.length === 0) return null;
  const lowerKeywords = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
  if (lowerKeywords.length === 0) return null;
  for (const segment of transcript) {
    if (overlapSeconds(shot.tStart, shot.tEnd, segment.t0, segment.t1) <= 0) continue;
    const lowerText = segment.text.toLowerCase();
    for (const keyword of lowerKeywords) {
      if (lowerText.includes(keyword)) return { segment, keyword };
    }
  }
  return null;
}

function computeAudioComponent(
  shot: Shot,
  events: AudioEvent[] | undefined,
  intensityP95: number,
): number {
  const found = findMaxAudioEvent(shot, events);
  if (!found) return 0;
  const normalized = normalize(found.event.intensity, intensityP95);
  const scale = Math.min(1, found.overlapS / 1);
  return normalized * scale;
}

/**
 * Fraction of the shot covered by transcript segments, with near-duplicate
 * repeats down-weighted (see transcriptSpeechWeights) so hallucination loops
 * don't read as dense speech. A keyword hit still boosts to 1 regardless —
 * keywords are an explicit user ask.
 */
function computeSpeechComponent(
  shot: Shot,
  transcript: TranscriptSegment[],
  segmentWeights: number[],
  keywords: string[],
): number {
  const duration = shot.tEnd - shot.tStart;
  if (duration <= 0) return 0;
  let covered = 0;
  for (let i = 0; i < transcript.length; i += 1) {
    const segment = transcript[i];
    covered +=
      overlapSeconds(shot.tStart, shot.tEnd, segment.t0, segment.t1) * (segmentWeights[i] ?? 1);
  }
  const fraction = Math.min(1, covered / duration);
  return findKeywordMatch(shot, transcript, keywords) ? 1 : fraction;
}

function formatHHMM(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

function clipsLabel(n: number): string {
  return `${n} clip${n === 1 ? "" : "s"}`;
}

function buildChapter(index: number, clips: ClipDossier[]): Chapter {
  const first = clips[0].recordedAt as number;
  const last = clips[clips.length - 1].recordedAt as number;
  const timeLabel = first === last ? formatHHMM(first) : `${formatHHMM(first)}–${formatHHMM(last)}`;
  return {
    index,
    clipIds: clips.map((c) => c.clipId),
    startedAt: first,
    label: `ch ${index + 1} · ${timeLabel} UTC · ${clipsLabel(clips.length)}`,
  };
}

function buildUnknownChapter(index: number, clips: ClipDossier[]): Chapter {
  return {
    index,
    clipIds: clips.map((c) => c.clipId),
    startedAt: null,
    label: `ch ${index + 1} · unknown time · ${clipsLabel(clips.length)}`,
  };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

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
  if (dossiers.length === 0) return [];

  const withTime = dossiers.filter((d) => d.recordedAt !== null);
  const withoutTime = dossiers.filter((d) => d.recordedAt === null);
  // Reimplemented locally (not imported from director-prompt.ts, which is
  // mid-edit elsewhere): sort ascending, nulls-last convention via Infinity.
  // recordedAt is the file mtime = when recording STOPPED, so the gap we
  // measure between clip N and clip N+1 is stop-time-to-stop-time — that's
  // an approximation of the real gap (it's off by clip N's own duration in
  // the "no gap at all" direction) but is what's available and is
  // monotonic/consistent for splitting long idle stretches into chapters.
  const sorted = [...withTime].sort((a, b) => (a.recordedAt as number) - (b.recordedAt as number));

  const gapMs = config.chapterGapMinutes * 60_000;
  const chapters: Chapter[] = [];
  let current: ClipDossier[] = [];

  for (const dossier of sorted) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = (dossier.recordedAt as number) - (prev.recordedAt as number);
      if (gap > gapMs) {
        chapters.push(buildChapter(chapters.length, current));
        current = [];
      }
    }
    current.push(dossier);
  }
  if (current.length > 0) chapters.push(buildChapter(chapters.length, current));

  if (withoutTime.length > 0) {
    chapters.push(buildUnknownChapter(chapters.length, withoutTime));
  }

  return chapters;
}

/**
 * Score every shot of every dossier. Component normalization (motion,
 * aesthetic) is across ALL passed dossiers so scores are comparable
 * set-wide. Audio component: overlap with dossier.audioEvents scaled by
 * intensity (0 when the clip has no audio signals yet). Speech component:
 * fraction of the shot covered by transcript segments — hallucination loops
 * down-weighted (transcriptSpeechWeights) — boosted to 1 when a config
 * keyword appears in an overlapping segment. Sharpness is judged on the
 * full-res scale (PROXY_SHARPNESS_SCALE for proxy-analyzed clips); in
 * "penalize" mode a below-threshold shot is scored down instead of gated.
 */
export function scoreShots(
  dossiers: ClipDossier[],
  config: SelectorConfig = DEFAULT_SELECTOR_CONFIG,
): ShotScore[] {
  const entries: { dossier: ClipDossier; shot: Shot }[] = [];
  for (const dossier of dossiers) {
    for (const shot of dossier.shots) entries.push({ dossier, shot });
  }

  const motionP95 = percentile(
    entries.map((e) => e.shot.motion.score),
    0.95,
  );
  // Sharpness comparisons all happen on the full-res scale (proxy-analyzed
  // clips scaled up by PROXY_SHARPNESS_SCALE) so mixed proxy/full sets share
  // one normalization and one gate constant.
  const sharpnessP95 = percentile(
    entries.map((e) => bucketSharpness(e.dossier, e.shot)),
    0.95,
  );
  const allIntensities: number[] = [];
  for (const dossier of dossiers) {
    if (dossier.audioEvents) {
      for (const event of dossier.audioEvents) allIntensities.push(event.intensity);
    }
  }
  const intensityP95 = percentile(allIntensities, 0.95);

  // Hallucination-collapse weights are per-transcript, so compute once per
  // dossier rather than once per shot.
  const speechWeightsByClip = new Map<string, number[]>();
  for (const dossier of dossiers) {
    speechWeightsByClip.set(dossier.clipId, transcriptSpeechWeights(dossier.transcript));
  }

  const { weights, gate } = config;
  const weightsSum = weights.motion + weights.audio + weights.speech + weights.aesthetic;

  return entries.map(({ dossier, shot }) => {
    const duration = shot.tEnd - shot.tStart;
    const sharpness = bucketSharpness(dossier, shot);
    const components: ShotScoreComponents = {
      motion: normalize(shot.motion.score, motionP95),
      audio: computeAudioComponent(shot, dossier.audioEvents, intensityP95),
      speech: computeSpeechComponent(
        shot,
        dossier.transcript,
        speechWeightsByClip.get(dossier.clipId) ?? [],
        config.keywords,
      ),
      aesthetic: normalize(sharpness, sharpnessP95),
    };

    const composite =
      weightsSum > 0
        ? (components.motion * weights.motion +
            components.audio * weights.audio +
            components.speech * weights.speech +
            components.aesthetic * weights.aesthetic) /
          weightsSum
        : 0;

    const gateReasons: string[] = [];
    let softPenalty = 0;
    if (sharpness < gate.minSharpness) {
      if (gate.sharpnessMode === "penalize") {
        // Linear in the shortfall: full softFocusPenalty at sharpness 0,
        // fading to 0 at the gate threshold.
        const shortfall = gate.minSharpness > 0 ? 1 - sharpness / gate.minSharpness : 0;
        softPenalty = gate.softFocusPenalty * shortfall;
      } else {
        gateReasons.push(
          `blurry (sharpness ${Math.round(sharpness)} < ${Math.round(gate.minSharpness)})`,
        );
      }
    }
    if (duration < gate.minShotS) {
      gateReasons.push(`too short (${duration.toFixed(1)}s < ${gate.minShotS.toFixed(1)}s)`);
    }

    return {
      clipId: dossier.clipId,
      fileName: dossier.fileName,
      shotIndex: shot.index,
      gated: gateReasons.length > 0,
      gateReasons,
      components,
      softPenalty,
      score: Math.max(0, composite - softPenalty),
    };
  });
}

interface Candidate {
  clipId: string;
  fileName: string;
  shotIndex: number;
  score: number;
  recordedAt: number | null;
  embedding: Float32Array | null;
  shot: Shot;
  dossier: ClipDossier;
  components: ShotScoreComponents;
}

type ReasonComponent = keyof ShotScoreComponents;
const REASON_COMPONENT_ORDER: ReasonComponent[] = ["motion", "audio", "speech", "aesthetic"];
/** A component earns a reason string when it supplies >= this share of the composite score. */
const REASON_SHARE_THRESHOLD = 0.3;

function componentReason(
  component: ReasonComponent,
  candidate: Candidate,
  keywords: string[],
): string {
  switch (component) {
    case "motion":
      return `high motion (${Math.round(candidate.shot.motion.score)})`;
    case "aesthetic":
      return "sharp";
    case "speech": {
      const match = findKeywordMatch(candidate.shot, candidate.dossier.transcript, keywords);
      return match ? `keyword "${match.keyword}"` : "speech";
    }
    case "audio": {
      const found = findMaxAudioEvent(candidate.shot, candidate.dossier.audioEvents);
      return found ? `loud moment (z ${found.event.intensity.toFixed(1)})` : "loud moment";
    }
  }
}

/** Dominant-component reasons for a pick, largest weighted share first. */
function buildReasons(candidate: Candidate, weights: SelectorWeights, keywords: string[]): string[] {
  const weighted: Record<ReasonComponent, number> = {
    motion: candidate.components.motion * weights.motion,
    audio: candidate.components.audio * weights.audio,
    speech: candidate.components.speech * weights.speech,
    aesthetic: candidate.components.aesthetic * weights.aesthetic,
  };

  let chosen = REASON_COMPONENT_ORDER.filter(
    (c) => candidate.score > 0 && weighted[c] / candidate.score >= REASON_SHARE_THRESHOLD,
  );
  if (chosen.length === 0) {
    let best = REASON_COMPONENT_ORDER[0];
    for (const c of REASON_COMPONENT_ORDER) if (weighted[c] > weighted[best]) best = c;
    chosen = [best];
  } else {
    chosen = [...chosen].sort((a, b) => weighted[b] - weighted[a]);
  }

  return chosen.map((c) => componentReason(c, candidate, keywords));
}

/** Earlier recordedAt (nulls last), then lower shotIndex — deterministic tie-break. */
function tieBreakBetter(a: Candidate, b: Candidate): boolean {
  const at = a.recordedAt ?? Infinity;
  const bt = b.recordedAt ?? Infinity;
  if (at !== bt) return at < bt;
  return a.shotIndex < b.shotIndex;
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
  const chapters = segmentChapters(dossiers, config);
  const scores = scoreShots(dossiers, config);

  const dossierById = new Map(dossiers.map((d) => [d.clipId, d]));
  const scoreByKey = new Map(scores.map((s) => [`${s.clipId}#${s.shotIndex}`, s]));

  const picks: CandidatePick[] = [];
  const pickedEmbeddings: Float32Array[] = [];

  for (const chapter of chapters) {
    const candidates: Candidate[] = [];
    for (const clipId of chapter.clipIds) {
      const dossier = dossierById.get(clipId);
      if (!dossier) continue;
      for (const shot of dossier.shots) {
        const shotScore = scoreByKey.get(`${clipId}#${shot.index}`);
        if (!shotScore || shotScore.gated) continue;
        candidates.push({
          clipId,
          fileName: dossier.fileName,
          shotIndex: shot.index,
          score: shotScore.score,
          recordedAt: dossier.recordedAt,
          embedding: shot.embedding,
          shot,
          dossier,
          components: shotScore.components,
        });
      }
    }

    const remaining = [...candidates];
    let rank = 1;
    while (remaining.length > 0 && rank <= config.topPerChapter) {
      let bestIndex = 0;
      let bestFinal = -Infinity;
      let bestPenalty = 0;
      for (let i = 0; i < remaining.length; i += 1) {
        const candidate = remaining[i];
        let penalty = 0;
        if (candidate.embedding && pickedEmbeddings.length > 0) {
          let maxCos = -Infinity;
          for (const picked of pickedEmbeddings) {
            const cos = dot(candidate.embedding, picked);
            if (cos > maxCos) maxCos = cos;
          }
          penalty = config.uniquenessPenalty * maxCos;
        }
        const final = candidate.score - penalty;
        if (
          i === 0 ||
          final > bestFinal ||
          (final === bestFinal && tieBreakBetter(candidate, remaining[bestIndex]))
        ) {
          bestFinal = final;
          bestIndex = i;
          bestPenalty = penalty;
        }
      }

      const [picked] = remaining.splice(bestIndex, 1);
      picks.push({
        clipId: picked.clipId,
        fileName: picked.fileName,
        shotIndex: picked.shotIndex,
        chapterIndex: chapter.index,
        rank,
        finalScore: bestFinal,
        uniquenessPenalty: bestPenalty,
        reasons: buildReasons(picked, config.weights, config.keywords),
      });
      if (picked.embedding) pickedEmbeddings.push(picked.embedding);
      rank += 1;
    }
  }

  return { config, chapters, scores, picks };
}

/** Convenience: picks for one clip, sorted by shot index (filmstrip badges). */
export function picksForClip(selection: SelectionResult, clipId: string): CandidatePick[] {
  return selection.picks
    .filter((p) => p.clipId === clipId)
    .sort((a, b) => a.shotIndex - b.shotIndex);
}

/** The shot a pick refers to, or null when the dossier/shot is missing. */
export function pickShot(dossiers: ClipDossier[], pick: CandidatePick): Shot | null {
  const dossier = dossiers.find((d) => d.clipId === pick.clipId);
  if (!dossier) return null;
  return dossier.shots[pick.shotIndex] ?? null;
}
