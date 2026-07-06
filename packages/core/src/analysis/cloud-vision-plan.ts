/**
 * Pure planning/merging for the opt-in cloud vision pass. The web layer does
 * the actual network call; everything here is deterministic and unit-tested:
 * which frames to send for a scope, and how results land back in the dossier.
 */

import { similarCaptions } from "./caption-text";
import type { ClipDossier, CloudRunMeta, DenseCaption, DenseFrame } from "./types";

export type CloudScope = "shots" | "timeline";

/** Hard ceiling on frames per enhance run (cost/latency sanity, ~pennies). */
export const MAX_CLOUD_FRAMES = 600;

/**
 * Dense frames below this laplacian variance (at scan resolution) are too
 * blurry to be worth a cloud call; they get a local "unusable" annotation
 * instead. ~50 separates motion smear from usable handheld footage.
 */
export const BLUR_SHARPNESS_THRESHOLD = 50;

/** Timeline annotation for frames skipped by the blur gate (director-visible). */
export const BLURRY_FRAME_CAPTION =
  "unusable: frame too blurry / motion-smeared to describe";

/**
 * A frame to send to the cloud captioner. When `t1` is set the frame is the
 * representative of a visually static span [t, t1] — near-identical
 * neighbors were merged away and its caption applies to the whole span.
 */
export interface CloudFrame extends DenseFrame {
  t1?: number;
}

export interface CloudFramePlan {
  frames: CloudFrame[];
  /** Timeline frames the blur gate dropped (annotate locally, send nothing). */
  blurrySkipped: DenseFrame[];
}

/**
 * Cost-aware frame plan for an enhance run. Shots scope is unchanged (one
 * frame per shot; reps were already sharpness-picked, and skipping one would
 * leave its shot undescribed). Timeline scope drops blurry frames, then
 * merges runs of consecutive frames whose LOCAL captions are near-identical
 * (word-Jaccard, same gate the prompt timeline uses) into one representative
 * frame + time span. Frames the local caption pass hasn't reached never
 * merge — there is nothing to judge similarity with.
 */
export interface PlanCloudFramesOpts {
  /**
   * When set, restrict the plan to the selector's candidate shots: shots
   * scope sends only these shots' rep frames; timeline scope keeps only
   * dense frames inside these shots' [tStart, tEnd] ranges (then blur-gates
   * and merges as usual). Unset = current behavior (all shots/frames).
   */
  candidateShotIndexes?: Set<number>;
}

export function planCloudFrames(
  dossier: ClipDossier,
  scope: CloudScope,
  opts: PlanCloudFramesOpts = {},
): CloudFramePlan {
  void opts; // consumed once candidate-driven planning lands (builder C)
  if (scope === "shots") {
    return { frames: selectCloudFrames(dossier, scope), blurrySkipped: [] };
  }

  const blurrySkipped: DenseFrame[] = [];
  const sharp: DenseFrame[] = [];
  for (const f of dossier.denseFrames) {
    if (f.sharpness !== undefined && f.sharpness < BLUR_SHARPNESS_THRESHOLD) {
      blurrySkipped.push(f);
    } else {
      sharp.push(f);
    }
  }

  const localByT = new Map(dossier.denseCaptions.map((c) => [c.t, c.text]));
  const frames: CloudFrame[] = [];
  // Similarity is judged against the run's FIRST caption (like
  // mergeDenseCaptions), so a chain of pairwise-similar captions can't
  // drift arbitrarily far from the representative actually sent.
  let repText: string | null = null;
  for (const f of sharp) {
    const text = localByT.get(f.t) ?? null;
    const rep = frames[frames.length - 1];
    // A blurry frame between two similar sharp frames doesn't break a run —
    // the scene is static, the middle frame was just smeared.
    if (rep && text !== null && repText !== null && similarCaptions(repText, text)) {
      rep.t1 = f.t;
    } else {
      frames.push({ ...f });
      repText = text;
    }
  }
  return { frames: frames.slice(0, MAX_CLOUD_FRAMES), blurrySkipped };
}

/**
 * Re-expand span captions after the cloud run: a caption whose frame
 * represented [t, t1] is duplicated at t1, so the prompt's run-length merge
 * (identical text) renders the full range instead of a point in time.
 */
export function expandSpanCaptions(
  captions: DenseCaption[],
  frames: CloudFrame[],
): DenseCaption[] {
  const spanEnd = new Map<number, number>();
  for (const f of frames) {
    if (f.t1 !== undefined && f.t1 > f.t) spanEnd.set(f.t, f.t1);
  }
  const out: DenseCaption[] = [];
  for (const c of captions) {
    out.push(c);
    const t1 = spanEnd.get(c.t);
    if (t1 !== undefined) out.push({ t: t1, text: c.text });
  }
  return out;
}

/** Director-visible annotations for frames the blur gate skipped. */
export function blurryAnnotations(blurrySkipped: DenseFrame[]): DenseCaption[] {
  return blurrySkipped.map((f) => ({ t: f.t, text: BLURRY_FRAME_CAPTION }));
}

/**
 * Frames to send for a scope:
 *  - "shots": the dense frame nearest each shot's representative time — one
 *    good frame per shot (falls back to the shot thumbnail when no dense
 *    frame landed within the shot).
 *  - "timeline": every dense frame the adaptive sampler kept.
 * Deduplicated and time-ordered.
 */
export function selectCloudFrames(dossier: ClipDossier, scope: CloudScope): DenseFrame[] {
  if (scope === "timeline") {
    return dossier.denseFrames.slice(0, MAX_CLOUD_FRAMES);
  }
  const picked = new Map<number, DenseFrame>(); // keyed by t (dedup)
  for (const shot of dossier.shots) {
    let best: DenseFrame | null = null;
    for (const f of dossier.denseFrames) {
      if (f.t < shot.tStart - 1 || f.t > shot.tEnd + 1) continue;
      if (!best || Math.abs(f.t - shot.repFrameTime) < Math.abs(best.t - shot.repFrameTime)) {
        best = f;
      }
    }
    if (!best && shot.thumbnailDataUrl) {
      best = { t: shot.repFrameTime, dataUrl: shot.thumbnailDataUrl };
    }
    if (best) picked.set(best.t, best);
  }
  return [...picked.values()].sort((a, b) => a.t - b.t).slice(0, MAX_CLOUD_FRAMES);
}

/**
 * Write cloud results into the dossier (mutates, matching how local captions
 * land). Each scope owns its own store so runs COEXIST for comparison:
 * timeline fills cloudDenseCaptions; shots fills cloudShotCaptions and each
 * shot's cloudCaption (nearest to its rep frame). Per-scope stats land in
 * cloudRuns; the legacy cloudVision marker tracks the latest run.
 */
export function applyCloudResults(
  dossier: ClipDossier,
  scope: CloudScope,
  results: DenseCaption[],
  meta: CloudRunMeta,
): void {
  const sorted = [...results].sort((a, b) => a.t - b.t);
  if (scope === "timeline") {
    dossier.cloudDenseCaptions = sorted;
  } else {
    dossier.cloudShotCaptions = sorted;
    for (const shot of dossier.shots) {
      let best: DenseCaption | null = null;
      for (const c of sorted) {
        if (c.t < shot.tStart - 1 || c.t > shot.tEnd + 1) continue;
        if (!best || Math.abs(c.t - shot.repFrameTime) < Math.abs(best.t - shot.repFrameTime)) {
          best = c;
        }
      }
      if (best) shot.cloudCaption = best.text;
    }
  }
  dossier.cloudRuns[scope] = meta;
  dossier.cloudVision = { model: meta.model, enhancedAt: meta.enhancedAt, scope };
  // Archive by (scope, model): rerunning a combination replaces its entry;
  // other models' runs survive for side-by-side comparison.
  dossier.cloudRunArchive = [
    ...dossier.cloudRunArchive.filter(
      (e) => !(e.scope === scope && e.model === meta.model),
    ),
    { scope, model: meta.model, captions: sorted, meta },
  ];
}
