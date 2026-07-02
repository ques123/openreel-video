/**
 * Pure text helpers for the dense caption timeline: strip Florence's
 * boilerplate framing, and run-length merge consecutive near-identical
 * descriptions so a 15-minute drive ("road, trees, sky" x200) compresses to
 * a handful of readable timeline segments for the director prompt.
 */

import type { DenseCaption } from "./types";

/** "In this image we can see a wall." -> "a wall" */
export function cleanCaption(raw: string): string {
  return raw
    .replace(/^in this image[,]?\s*(we can see|i can see|there is|there are)\s*/i, "")
    .replace(/\s*\.\s*(In this image[,]?\s*)?(we can see|i can see|we can also see|i can also see)\s*/gi, "; ")
    .replace(/\s+/g, " ")
    .replace(/[.;\s]+$/, "")
    .trim();
}

export interface TimelineSegment {
  t0: number;
  t1: number;
  text: string;
}

/** Word-set Jaccard similarity — driving footage repeats with tiny variations. */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter) >= 0.7;
}

/**
 * Merge consecutive similar captions into time-ranged segments. The FIRST
 * caption of a run names the whole segment (they're near-identical anyway).
 */
export function mergeDenseCaptions(captions: DenseCaption[]): TimelineSegment[] {
  const sorted = [...captions].sort((a, b) => a.t - b.t);
  const segments: TimelineSegment[] = [];
  for (const c of sorted) {
    const last = segments[segments.length - 1];
    if (last && similar(last.text, c.text)) {
      last.t1 = c.t;
    } else {
      segments.push({ t0: c.t, t1: c.t, text: c.text });
    }
  }
  return segments;
}
