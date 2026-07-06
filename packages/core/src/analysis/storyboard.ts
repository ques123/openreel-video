/**
 * Storyboard validation: turn a raw submit_storyboard tool call (untrusted
 * JSON from the LLM) into a clean Storyboard, or a list of errors to bounce
 * back so the model can fix its submission.
 *
 * Policy: errors reject the WHOLE submission (the loop feeds them back and
 * the model retries); warnings record clamps/drift we silently accepted and
 * are surfaced in the UI. "Never clip mid-word" is enforced here, not just in
 * the prompt: cut points inside a spoken transcript segment snap to the
 * nearest segment boundary when one is close, and warn otherwise.
 */

import { dot } from "./shot-metrics";
import type { ClipDossier, Shot, TranscriptSegment } from "./types";
import type { Storyboard, StoryboardItem } from "./director-types";

export interface StoryboardValidation {
  /** Null when the submission is structurally unusable (nothing salvageable). */
  storyboard: Storyboard | null;
  errors: string[];
  warnings: string[];
  /** Structured duration-vs-target outcome; null without a target or storyboard. */
  duration: StoryboardDurationCheck | null;
  /** Zero-inference eval metrics of the validated items; null when storyboard is. */
  metrics: StoryboardMetrics | null;
}

export interface StoryboardDurationCheck {
  targetS: number;
  totalS: number;
  /** |total − target| / target. */
  driftFrac: number;
  /** Set when the drift exceeds the ±10% error tolerance. */
  violation: "over" | "under" | null;
}

/**
 * Zero-inference quality metrics of a storyboard, computed from data already
 * in the dossiers (transcripts + shot embeddings) — logged per experiment so
 * prompt/selector tuning can be measured instead of eyeballed.
 */
export interface StoryboardMetrics {
  /** Cut points examined (2 per item: in + out). */
  cutCount: number;
  /** Cuts landing >150ms inside a spoken transcript segment (after snapping). */
  midSpeechCutCount: number;
  /** midSpeechCutCount / cutCount; 0 when there are no cuts. */
  midSpeechCutFraction: number;
  /** Adjacent item pairs where both covering shots had embeddings. */
  adjacentPairCount: number;
  /** Mean cosine between adjacent items' shot embeddings; null without pairs. */
  adjacentCosineMean: number | null;
  /** Max adjacent cosine — near 1 means near-identical back-to-back shots. */
  adjacentCosineMax: number | null;
}

export interface ValidateStoryboardOpts {
  targetDurationS?: number | null;
  /** Segments shorter than this after clamping are rejected. */
  minItemS?: number;
}

/** Target-duration tolerance: outside ±10% is an error, ±5-10% a warning. */
const DURATION_ERROR_FRAC = 0.1;
const DURATION_WARN_FRAC = 0.05;
const DEFAULT_MIN_ITEM_S = 0.3;
/** Snap a mid-speech cut to a transcript-segment boundary within this. */
const SPEECH_SNAP_S = 0.3;
/** A cut deeper than this inside a spoken segment counts as mid-speech. */
const MID_SPEECH_CUT_S = 0.15;
/** Float slack: a cut this close to a boundary counts as ON it. */
const BOUNDARY_EPS_S = 1e-3;

const fmtS = (s: number) => s.toFixed(1);

function findCoveringShot(dossier: ClipDossier, t: number): Shot | null {
  for (const shot of dossier.shots) {
    if (t >= shot.tStart && t < shot.tEnd) return shot;
  }
  return dossier.shots.length > 0 ? dossier.shots[dossier.shots.length - 1] : null;
}

interface CutSnap {
  /** Cut time to use — the input when nothing snapped. */
  t: number;
  snapped: boolean;
  /** Set when the cut still lands mid-speech (deeper than MID_SPEECH_CUT_S). */
  midSpeech: { text: string; nearestBoundaryS: number } | null;
}

/**
 * Snap a cut point that lands inside a spoken transcript segment to the
 * nearest segment boundary within ±SPEECH_SNAP_S that stays inside
 * [min, max] (the item's clamp bounds / minimum-length budget). Cuts too
 * deep inside speech to snap are reported so the caller can warn.
 */
function snapCutToSpeech(
  t: number,
  transcript: TranscriptSegment[],
  min: number,
  max: number,
): CutSnap {
  const seg = transcript.find((s) => t > s.t0 + BOUNDARY_EPS_S && t < s.t1 - BOUNDARY_EPS_S);
  if (!seg) return { t, snapped: false, midSpeech: null };
  const boundaries = [seg.t0, seg.t1].sort((a, b) => Math.abs(t - a) - Math.abs(t - b));
  for (const b of boundaries) {
    if (Math.abs(t - b) <= SPEECH_SNAP_S && b >= min && b <= max) {
      return { t: b, snapped: true, midSpeech: null };
    }
  }
  const depth = Math.min(t - seg.t0, seg.t1 - t);
  if (depth <= MID_SPEECH_CUT_S) return { t, snapped: false, midSpeech: null };
  return {
    t,
    snapped: false,
    midSpeech: { text: seg.text.trim(), nearestBoundaryS: boundaries[0] },
  };
}

/** True when t sits more than MID_SPEECH_CUT_S inside any spoken segment. */
function isMidSpeechCut(t: number, transcript: TranscriptSegment[]): boolean {
  return transcript.some((s) => t - s.t0 > MID_SPEECH_CUT_S && s.t1 - t > MID_SPEECH_CUT_S);
}

/**
 * Compute StoryboardMetrics for a (validated) storyboard. Exported so the
 * director loop can recompute after mechanically trimming a salvaged board.
 */
export function computeStoryboardMetrics(
  storyboard: Storyboard,
  dossiers: ClipDossier[],
): StoryboardMetrics {
  const byId = new Map(dossiers.map((d) => [d.clipId, d]));
  let cutCount = 0;
  let midSpeechCutCount = 0;
  for (const item of storyboard.items) {
    const transcript = byId.get(item.clipId)?.transcript ?? [];
    for (const t of [item.inS, item.outS]) {
      cutCount += 1;
      if (isMidSpeechCut(t, transcript)) midSpeechCutCount += 1;
    }
  }

  // Adjacent-pair cosine over the covering shots' rep embeddings (all
  // L2-normalized, so cosine = dot) — the same uniqueness signal the
  // selector applies at pick time, re-measured on the final cut.
  const embeddingFor = (item: StoryboardItem): Float32Array | null => {
    const dossier = byId.get(item.clipId);
    if (!dossier) return null;
    const shot =
      (item.shotIndex !== null
        ? dossier.shots.find((s) => s.index === item.shotIndex)
        : null) ?? findCoveringShot(dossier, item.inS);
    return shot?.embedding ?? null;
  };
  const cosines: number[] = [];
  for (let i = 1; i < storyboard.items.length; i += 1) {
    const a = embeddingFor(storyboard.items[i - 1]);
    const b = embeddingFor(storyboard.items[i]);
    if (a && b) cosines.push(dot(a, b));
  }

  return {
    cutCount,
    midSpeechCutCount,
    midSpeechCutFraction: cutCount > 0 ? midSpeechCutCount / cutCount : 0,
    adjacentPairCount: cosines.length,
    adjacentCosineMean:
      cosines.length > 0 ? cosines.reduce((s, c) => s + c, 0) / cosines.length : null,
    adjacentCosineMax: cosines.length > 0 ? Math.max(...cosines) : null,
  };
}

export function validateStoryboard(
  rawArgsJson: string,
  dossiers: ClipDossier[],
  opts: ValidateStoryboardOpts = {},
): StoryboardValidation {
  const minItemS = opts.minItemS ?? DEFAULT_MIN_ITEM_S;
  const targetDurationS = opts.targetDurationS ?? null;
  const errors: string[] = [];
  const warnings: string[] = [];

  const unusable = (error: string): StoryboardValidation => ({
    storyboard: null,
    errors: [...errors, error],
    warnings,
    duration: null,
    metrics: null,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(rawArgsJson);
  } catch {
    return unusable("arguments are not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { items?: unknown }).items)) {
    return unusable('missing "items" array');
  }
  const rawObj = raw as { title?: unknown; notes?: unknown; items: unknown[] };
  if (rawObj.items.length === 0) {
    return unusable('"items" is empty');
  }

  const byClipId = new Map(dossiers.map((d) => [d.clipId, d]));
  const byFileName = new Map(dossiers.map((d) => [d.fileName, d]));
  const knownIds = dossiers.map((d) => d.clipId).join(", ");

  const items: StoryboardItem[] = [];
  rawObj.items.forEach((rawItem, i) => {
    const label = `item ${i + 1}`;
    if (typeof rawItem !== "object" || rawItem === null) {
      errors.push(`${label}: not an object`);
      return;
    }
    const it = rawItem as Record<string, unknown>;

    // Models occasionally put the file name where the clip id belongs.
    const idField = typeof it.clipId === "string" ? it.clipId : "";
    const dossier = byClipId.get(idField) ?? byFileName.get(idField);
    if (!dossier) {
      errors.push(`${label}: unknown clipId "${idField}" — known: ${knownIds}`);
      return;
    }

    let shotIndex: number | null =
      typeof it.shotIndex === "number" && Number.isInteger(it.shotIndex) ? it.shotIndex : null;
    let shot: Shot | null = null;
    if (shotIndex !== null) {
      shot = dossier.shots.find((s) => s.index === shotIndex) ?? null;
      if (!shot) {
        warnings.push(`${label}: shot #${shotIndex} does not exist in ${dossier.clipId}; used clip bounds`);
        shotIndex = null;
      }
    }

    const rawIn = typeof it.in === "number" ? it.in : NaN;
    const rawOut = typeof it.out === "number" ? it.out : NaN;
    if (!Number.isFinite(rawIn) || !Number.isFinite(rawOut)) {
      errors.push(`${label}: "in"/"out" must be finite numbers`);
      return;
    }

    // Clamp to the shot when anchored, else to the clip's ANALYZED range —
    // content past analyzedThroughS is unknown to the model, never select it.
    const lo = shot ? shot.tStart : 0;
    const hi = shot ? shot.tEnd : (dossier.analyzedThroughS ?? dossier.durationS);
    let inS = Math.min(Math.max(rawIn, lo), hi);
    let outS = Math.min(Math.max(rawOut, lo), hi);
    if (inS !== rawIn || outS !== rawOut) {
      warnings.push(
        `${label}: range ${fmtS(rawIn)}-${fmtS(rawOut)}s clamped to ${fmtS(inS)}-${fmtS(outS)}s` +
          (shot ? ` (shot #${shot.index})` : ""),
      );
    }
    if (outS - inS < minItemS) {
      errors.push(
        `${label}: only ${fmtS(outS - inS)}s long after clamping to ` +
          `${fmtS(lo)}-${fmtS(hi)}s (min ${fmtS(minItemS)}s) — pick a range inside the bounds`,
      );
      return;
    }

    // "Never clip mid-word": snap cuts inside a spoken segment to the nearest
    // boundary when one is within ±SPEECH_SNAP_S (and stays inside the clamp
    // bounds / minimum length); deeper mid-speech cuts can't be fixed
    // mechanically, so they warn instead.
    const speechWarn = (which: "in" | "out", t: number, mid: NonNullable<CutSnap["midSpeech"]>) =>
      warnings.push(
        `${label}: "${which}" at ${t.toFixed(2)}s cuts mid-speech ("${mid.text}") — ` +
          `nearest boundary ${mid.nearestBoundaryS.toFixed(2)}s`,
      );
    const inSnap = snapCutToSpeech(inS, dossier.transcript, lo, outS - minItemS);
    if (inSnap.snapped) {
      warnings.push(
        `${label}: "in" ${inS.toFixed(2)}s → ${inSnap.t.toFixed(2)}s (snapped to speech boundary)`,
      );
      inS = inSnap.t;
    } else if (inSnap.midSpeech) {
      speechWarn("in", inS, inSnap.midSpeech);
    }
    const outSnap = snapCutToSpeech(outS, dossier.transcript, inS + minItemS, hi);
    if (outSnap.snapped) {
      warnings.push(
        `${label}: "out" ${outS.toFixed(2)}s → ${outSnap.t.toFixed(2)}s (snapped to speech boundary)`,
      );
      outS = outSnap.t;
    } else if (outSnap.midSpeech) {
      speechWarn("out", outS, outSnap.midSpeech);
    }

    const coveringShot = shot ?? findCoveringShot(dossier, inS);
    items.push({
      clipId: dossier.clipId,
      fileName: dossier.fileName,
      shotIndex: shot ? shot.index : null,
      inS,
      outS,
      role: typeof it.role === "string" && it.role.trim() ? it.role.trim() : "segment",
      why: typeof it.why === "string" ? it.why.trim() : "",
      thumbnailDataUrl: coveringShot?.thumbnailDataUrl ?? null,
    });
  });

  if (items.length === 0) {
    return { storyboard: null, errors, warnings, duration: null, metrics: null };
  }

  // Flag backward jumps in real-world time (clip mtime + offset within the
  // clip). Warning, not error: hook-first structures legitimately pull a
  // later moment forward — but silent shuffling breaks the trip's narrative.
  const byId = new Map(dossiers.map((d) => [d.clipId, d]));
  for (let i = 1; i < items.length; i += 1) {
    const prevClip = byId.get(items[i - 1].clipId);
    const curClip = byId.get(items[i].clipId);
    if (!prevClip || !curClip) continue;
    if (prevClip.recordedAt === null || curClip.recordedAt === null) continue;
    const prevT = prevClip.recordedAt + items[i - 1].inS * 1000;
    const curT = curClip.recordedAt + items[i].inS * 1000;
    if (curT < prevT) {
      warnings.push(
        `segments ${i}→${i + 1} jump BACK in time (${prevClip.fileName} was recorded after ` +
          `${curClip.fileName}) — fine if deliberate (e.g. a hook), otherwise reorder`,
      );
    }
  }

  let duration: StoryboardDurationCheck | null = null;
  if (targetDurationS !== null && targetDurationS > 0) {
    let total = 0;
    for (const item of items) total += item.outS - item.inS;
    const drift = Math.abs(total - targetDurationS) / targetDurationS;
    duration = {
      targetS: targetDurationS,
      totalS: total,
      driftFrac: drift,
      violation:
        drift > DURATION_ERROR_FRAC ? (total > targetDurationS ? "over" : "under") : null,
    };
    if (drift > DURATION_ERROR_FRAC) {
      errors.push(
        `total duration ${fmtS(total)}s is ${total > targetDurationS ? "over" : "under"} the ` +
          `${fmtS(targetDurationS)}s target by ${Math.round(drift * 100)}% (max ±10%) — ` +
          `adjust segment lengths or count`,
      );
    } else if (drift > DURATION_WARN_FRAC) {
      warnings.push(
        `total duration ${fmtS(total)}s vs target ${fmtS(targetDurationS)}s (${Math.round(drift * 100)}% off)`,
      );
    }
  }

  const storyboard: Storyboard = {
    title: typeof rawObj.title === "string" ? rawObj.title : null,
    notes: typeof rawObj.notes === "string" ? rawObj.notes : null,
    items,
  };
  return {
    storyboard,
    errors,
    warnings,
    duration,
    metrics: computeStoryboardMetrics(storyboard, dossiers),
  };
}

export interface StoryboardTrimResult {
  storyboard: Storyboard;
  /** Whole segments dropped from the tail. */
  droppedItems: number;
  /** Seconds shaved off the final kept segment. */
  shortenedLastByS: number;
  finalDurationS: number;
}

/**
 * Mechanically trim an over-length storyboard toward the target: drop whole
 * tail segments while doing so stays at/above the target, then shorten the
 * new last segment (never below minItemS). Narrative order and the opening
 * hook are preserved. Used by the director loop's out-of-rounds salvage.
 */
export function trimStoryboardToTarget(
  storyboard: Storyboard,
  targetS: number,
  minItemS = DEFAULT_MIN_ITEM_S,
): StoryboardTrimResult {
  const items = [...storyboard.items];
  const durOf = (it: StoryboardItem) => it.outS - it.inS;
  let total = items.reduce((s, it) => s + durOf(it), 0);
  let dropped = 0;
  while (items.length > 1 && total - durOf(items[items.length - 1]) >= targetS) {
    total -= durOf(items[items.length - 1]);
    items.pop();
    dropped += 1;
  }
  let shortened = 0;
  const over = total - targetS;
  if (over > 0 && items.length > 0) {
    const last = items[items.length - 1];
    const cut = Math.min(over, Math.max(0, durOf(last) - minItemS));
    if (cut > 0) {
      items[items.length - 1] = { ...last, outS: last.outS - cut };
      total -= cut;
      shortened = cut;
    }
  }
  return {
    storyboard: { ...storyboard, items },
    droppedItems: dropped,
    shortenedLastByS: shortened,
    finalDurationS: total,
  };
}
