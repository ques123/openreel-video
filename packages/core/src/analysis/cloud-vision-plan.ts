/**
 * Pure planning/merging for the opt-in cloud vision pass. The web layer does
 * the actual network call; everything here is deterministic and unit-tested:
 * which frames to send for a scope, and how results land back in the dossier.
 */

import type { ClipDossier, CloudVisionMeta, DenseCaption, DenseFrame } from "./types";

export type CloudScope = "shots" | "timeline";

/** Hard ceiling on frames per enhance run (cost/latency sanity, ~pennies). */
export const MAX_CLOUD_FRAMES = 600;

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
 * land). Timeline scope fills cloudDenseCaptions; both scopes give each shot
 * the cloud description nearest its rep frame.
 */
export function applyCloudResults(
  dossier: ClipDossier,
  scope: CloudScope,
  results: DenseCaption[],
  meta: Omit<CloudVisionMeta, "scope">,
): void {
  const sorted = [...results].sort((a, b) => a.t - b.t);
  if (scope === "timeline") {
    dossier.cloudDenseCaptions = sorted;
  }
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
  dossier.cloudVision = { ...meta, scope };
}
