/**
 * Segment seek/advance decisions for the screening-room player — kept pure
 * and DOM-free so they're unit-testable without real <video> playback
 * (mirrors the proven pattern in
 * pages/lab/components/StoryboardPreviewModal.tsx + segment-boundary.ts;
 * reimplemented here rather than imported, since publicapp/ must not import
 * non-type code from pages/lab/ — see publicflow/types.ts's bundle-rule
 * comment). The DOM glue (rVFC loop + timeupdate fallback) lives in
 * components/Player.tsx.
 */

/**
 * How close to a segment's out-point counts as "reached it". ~1.5 frames at
 * 30fps — absorbs float time math so a boundary trips at most one frame
 * early rather than presenting frames past the out-point.
 */
export const SEGMENT_END_EPSILON_S = 0.05;

/** True once the presented time has reached the segment's out-point. */
export function pastSegmentEnd(presentedTimeS: number, outS: number): boolean {
  return presentedTimeS >= outS - SEGMENT_END_EPSILON_S;
}

/** Index of the segment to play after `index`, or null when the cut is done. */
export function nextSegmentIndex(index: number, segmentCount: number): number | null {
  return index + 1 < segmentCount ? index + 1 : null;
}

/**
 * Which segment a click on the segment strip (or a scrub of the overall
 * cut-relative time) should jump the playhead to. `segments` are cut-relative
 * cumulative ranges (see `cutRelativeRanges`); returns the last segment when
 * `atS` is past the end (clamped, never null) and the first when before the
 * start — a strip click is always inside `[0, segments.length)` by
 * construction, but scrub bars can hand in slightly out-of-range values.
 */
export function segmentIndexAtCutTime(
  atS: number,
  ranges: readonly { startS: number; endS: number }[],
): number {
  if (ranges.length === 0) return 0;
  for (let i = 0; i < ranges.length; i += 1) {
    if (atS < ranges[i].endS - SEGMENT_END_EPSILON_S) return i;
  }
  return ranges.length - 1;
}

/** Cut-relative (cumulative) start/end for each segment, given source in/out durations. */
export function cutRelativeRanges(
  segments: readonly { inS: number; outS: number }[],
): { startS: number; endS: number }[] {
  const ranges: { startS: number; endS: number }[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const dur = Math.max(0, seg.outS - seg.inS);
    ranges.push({ startS: cursor, endS: cursor + dur });
    cursor += dur;
  }
  return ranges;
}
