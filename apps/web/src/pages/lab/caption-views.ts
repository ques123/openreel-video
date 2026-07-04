/**
 * Shared read-model helpers for viewing a dossier's captions: one accessor
 * per caption variant (local pass, cloud shots scope, cloud timeline scope),
 * and subtitle-style lookup of the caption in effect at a playback time.
 */

import type { ClipDossier, DenseCaption } from "@openreel/core";

/** The three caption variants a clip can carry. */
export type CaptionVariant = "local" | "cloud-shots" | "cloud-timeline";

export function localCaptionsOf(dossier: ClipDossier | null): DenseCaption[] {
  return dossier?.denseCaptions ?? [];
}

export function cloudShotCaptionsOf(dossier: ClipDossier | null): DenseCaption[] {
  return dossier?.cloudShotCaptions ?? [];
}

export function cloudTimelineCaptionsOf(dossier: ClipDossier | null): DenseCaption[] {
  return dossier?.cloudDenseCaptions ?? [];
}

export function captionsOf(
  dossier: ClipDossier | null,
  variant: CaptionVariant,
): DenseCaption[] {
  if (variant === "local") return localCaptionsOf(dossier);
  if (variant === "cloud-shots") return cloudShotCaptionsOf(dossier);
  return cloudTimelineCaptionsOf(dossier);
}

/** Variants present on a clip, in display order. */
export function availableVariants(dossier: ClipDossier | null): CaptionVariant[] {
  const out: CaptionVariant[] = [];
  if (localCaptionsOf(dossier).length > 0) out.push("local");
  if (cloudShotCaptionsOf(dossier).length > 0) out.push("cloud-shots");
  if (cloudTimelineCaptionsOf(dossier).length > 0) out.push("cloud-timeline");
  return out;
}

export const VARIANT_LABEL: Record<CaptionVariant, string> = {
  local: "local",
  "cloud-shots": "cloud·shots",
  "cloud-timeline": "cloud·timeline",
};

/**
 * Best available cloud descriptions (timeline preferred — it is denser).
 * Kept for call sites that just want "the cloud view".
 */
export function cloudCaptionsOf(dossier: ClipDossier | null): DenseCaption[] {
  const timeline = cloudTimelineCaptionsOf(dossier);
  return timeline.length > 0 ? timeline : cloudShotCaptionsOf(dossier);
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
