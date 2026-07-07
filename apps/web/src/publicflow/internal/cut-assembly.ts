/**
 * Pure mapping from the director's Storyboard IR (packages/core) to the
 * public product's PublicCut (types.ts) — the "shot list -> film" step the
 * public UI actually renders: per-segment "why", thumbnails already resolved
 * by validateStoryboard (never re-derived here), total duration via the
 * core helper, and a distinct-clip count for the screening room's summary.
 */
import { storyboardDurationS, type Storyboard } from "@openreel/core";
import type { PublicCut, PublicCutSegment } from "../types";

/** True when the storyboard's own title field is usable as-is (non-null, non-blank). */
export function hasStoryboardTitle(storyboard: Storyboard): boolean {
  return typeof storyboard.title === "string" && storyboard.title.trim().length > 0;
}

function toPublicCutSegment(item: Storyboard["items"][number]): PublicCutSegment {
  return {
    clipId: item.clipId,
    inS: item.inS,
    outS: item.outS,
    why: item.why,
    thumbnailUrl: item.thumbnailDataUrl,
  };
}

/**
 * Assembles the final PublicCut. `title` is resolved by the caller BEFORE
 * calling this (storyboard.title when usable, else an aux LLM call, else
 * film-title.ts's pure fallback — see use-public-director.ts) since title
 * resolution can involve a network call and this function stays pure.
 * `musicTakes` is null until (or unless) Suno generation lands — the cut
 * itself never waits on music (see use-public-director.ts's doc comment).
 */
export function assemblePublicCut(
  storyboard: Storyboard,
  title: string,
  musicTakes: { a: string; b: string } | null,
): PublicCut {
  return {
    title,
    totalS: storyboardDurationS(storyboard),
    segments: storyboard.items.map(toPublicCutSegment),
    clipCount: new Set(storyboard.items.map((item) => item.clipId)).size,
    musicTakes,
  };
}
