/**
 * Shared read-model helpers for viewing a dossier's captions: normalize the
 * two cloud shapes (timeline scope vs per-shot) into one timestamped list,
 * and subtitle-style lookup of the caption in effect at a playback time.
 */

import type { ClipDossier, DenseCaption } from "@openreel/core";

/**
 * Cloud descriptions regardless of enhance scope: the timeline scope filled
 * cloudDenseCaptions; the shots scope only wrote per-shot cloudCaptions,
 * which we surface at each shot's rep time.
 */
export function cloudCaptionsOf(dossier: ClipDossier | null): DenseCaption[] {
  if (!dossier) return [];
  if (dossier.cloudDenseCaptions.length > 0) return dossier.cloudDenseCaptions;
  return dossier.shots
    .filter((s) => s.cloudCaption)
    .map((s) => ({ t: s.repFrameTime, text: s.cloudCaption! }));
}

export function localCaptionsOf(dossier: ClipDossier | null): DenseCaption[] {
  return dossier?.denseCaptions ?? [];
}

/**
 * The caption in effect at time t, subtitle-style: the latest entry at or
 * before t, else the first entry within `lookaheadS` (so the moments before
 * the first sampled frame aren't blank). EPS absorbs video seek snapping:
 * seeking to a sampled frame's timestamp lands on the video's own frame
 * grid, often a few ms BEFORE the caption's t.
 */
export function captionAt(
  timeline: DenseCaption[],
  t: number,
  lookaheadS = 3,
): DenseCaption | null {
  const EPS = 0.35;
  let best: DenseCaption | null = null;
  for (const c of timeline) {
    if (c.t <= t + EPS) {
      if (!best || c.t > best.t) best = c;
    }
  }
  if (best) return best;
  let ahead: DenseCaption | null = null;
  for (const c of timeline) {
    if (c.t > t && c.t - t <= lookaheadS && (!ahead || c.t < ahead.t)) ahead = c;
  }
  return ahead;
}

/** Nearest caption to time t within `windowS`, for pairing rows across sources. */
export function captionNear(
  timeline: DenseCaption[],
  t: number,
  windowS = 5,
): DenseCaption | null {
  let best: DenseCaption | null = null;
  for (const c of timeline) {
    if (Math.abs(c.t - t) > windowS) continue;
    if (!best || Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
  }
  return best;
}
