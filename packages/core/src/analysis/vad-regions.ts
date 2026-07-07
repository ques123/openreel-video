/**
 * Pure region math for the whisper worker's VAD speech gate.
 *
 * Two very different backends produce "raw" speech regions in whisper-worker.ts
 * — a stateful Silero ONNX model scanning 512-sample frames, or (on fallback)
 * an energy/robust-z gate over the RMS envelope in audio-signal.ts — but both
 * hand off the same simple shape: a list of disjoint, ascending
 * `{ start, end }` spans in ABSOLUTE clip-time seconds. Everything here is
 * pure and backend-agnostic: it turns raw spans into the final list of
 * regions whisper actually transcribes, and offsets a region's
 * whisper-relative segment timestamps back into absolute clip time. No I/O,
 * no models, no workers — safe to unit test directly.
 */

import type { TranscriptSegment } from "./types";

/** A speech region, in ABSOLUTE clip-time seconds. */
export interface VadRegion {
  start: number;
  end: number;
}

/** Regions separated by less than this are merged into one. */
export const VAD_MERGE_GAP_S = 0.3;
/** Each region is padded by this much on both sides (clamped to clip bounds). */
export const VAD_PAD_S = 0.2;
/** Regions shorter than this AFTER padding are dropped. */
export const VAD_MIN_REGION_S = 0.25;

export interface ProcessVadRegionsOptions {
  /** Clip duration, seconds — padding clamps to [0, totalDurationS]. */
  totalDurationS: number;
  /**
   * Longest a single output region may be, seconds — regions longer than
   * this are split into consecutive sub-regions (last one gets the
   * remainder). Callers pass the whisper worker's macro-chunk size so a
   * VAD-gated region never exceeds the same bound the non-gated path
   * already reads in one piece.
   */
  maxRegionS: number;
  mergeGapS?: number;
  padS?: number;
  minRegionS?: number;
}

function sortedByStart(regions: VadRegion[]): VadRegion[] {
  return [...regions].sort((a, b) => a.start - b.start);
}

/**
 * Merge regions separated by a gap smaller than gapS (overlapping or exactly
 * touching regions always merge, since their gap is <= 0 < any gapS >= 0).
 * Input need not be sorted. Pure.
 */
export function mergeRegions(regions: VadRegion[], gapS: number = VAD_MERGE_GAP_S): VadRegion[] {
  if (regions.length === 0) return [];
  const sorted = sortedByStart(regions);
  const merged: VadRegion[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const region = sorted[i];
    const last = merged[merged.length - 1];
    if (region.start - last.end < gapS) {
      last.end = Math.max(last.end, region.end);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/**
 * Pad each region by padS on both sides, clamped to [0, totalDurationS].
 * Does NOT re-merge regions that padding brings together — callers that
 * need non-overlapping output must merge again afterward. Pure.
 */
export function padRegions(
  regions: VadRegion[],
  padS: number = VAD_PAD_S,
  totalDurationS: number = Infinity,
): VadRegion[] {
  return regions.map((r) => ({
    start: Math.max(0, r.start - padS),
    end: Math.min(totalDurationS, r.end + padS),
  }));
}

/** Drop regions shorter than minRegionS. Pure. */
export function dropShortRegions(
  regions: VadRegion[],
  minRegionS: number = VAD_MIN_REGION_S,
): VadRegion[] {
  return regions.filter((r) => r.end - r.start >= minRegionS);
}

/**
 * Split any region longer than maxRegionS into consecutive sub-regions of at
 * most maxRegionS each, in order; the last piece gets the (possibly
 * shorter) remainder. A region of exactly maxRegionS is left alone. Regions
 * are independent afterward — same "no ASR context across a boundary"
 * caveat that already applies to the non-VAD macro-chunk loop. Pure.
 */
export function splitLongRegions(regions: VadRegion[], maxRegionS: number): VadRegion[] {
  if (maxRegionS <= 0) return regions;
  const out: VadRegion[] = [];
  for (const region of regions) {
    const total = region.end - region.start;
    if (total <= maxRegionS) {
      out.push(region);
      continue;
    }
    let start = region.start;
    while (start < region.end) {
      const end = Math.min(start + maxRegionS, region.end);
      out.push({ start, end });
      start = end;
    }
  }
  return out;
}

/**
 * Full pipeline, in spec order: merge close raw regions -> pad each side ->
 * re-merge (padding can make neighbors touch or overlap; left un-merged,
 * whisper would double-transcribe the shared slice) -> drop regions still
 * under the floor -> split anything over the length cap.
 *
 * Padding runs BEFORE the drop specifically so a short blip that padding
 * pushes past minRegionS survives, the same as if it had simply lasted a
 * little longer — see the "short blip survives via padding" unit test.
 */
export function processVadRegions(
  rawRegions: VadRegion[],
  opts: ProcessVadRegionsOptions,
): VadRegion[] {
  const mergeGapS = opts.mergeGapS ?? VAD_MERGE_GAP_S;
  const padS = opts.padS ?? VAD_PAD_S;
  const minRegionS = opts.minRegionS ?? VAD_MIN_REGION_S;

  const merged = mergeRegions(rawRegions, mergeGapS);
  const padded = padRegions(merged, padS, opts.totalDurationS);
  const recoalesced = mergeRegions(padded, mergeGapS);
  const kept = dropShortRegions(recoalesced, minRegionS);
  return splitLongRegions(kept, opts.maxRegionS);
}

/**
 * Offset every segment's t0/t1 by offsetS. Used to map a region's
 * whisper-relative timestamps (whisper only ever sees the region's own
 * slice, starting at 0) back into absolute clip time — the offset MUST be
 * the segment's own region start, not the start of some larger region it
 * may have been split from (see vad-regions.test.ts's split+remap cases).
 * Pure.
 */
export function offsetSegments(
  segments: TranscriptSegment[],
  offsetS: number,
): TranscriptSegment[] {
  if (offsetS === 0) return segments;
  return segments.map((s) => ({ ...s, t0: s.t0 + offsetS, t1: s.t1 + offsetS }));
}
