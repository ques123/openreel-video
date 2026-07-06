/**
 * Segment-boundary decisions for StoryboardPreviewModal, kept pure for tests
 * (jsdom has neither video playback nor requestVideoFrameCallback). The DOM
 * glue — the rVFC loop and its timeupdate fallback — stays in the modal.
 */

/**
 * How close to a segment's out-point counts as "reached it". Shared by the
 * per-frame (rVFC) check and the ~250ms timeupdate fallback: ~1.5 frames at
 * 30fps, absorbing float time math, so a boundary can trip at most one frame
 * early rather than presenting frames past the out-point.
 */
export const SEGMENT_END_EPSILON_S = 0.05;

/** True once the presented time has reached the segment's out-point. */
export function pastSegmentEnd(currentTimeS: number, outS: number): boolean {
  return currentTimeS >= outS - SEGMENT_END_EPSILON_S;
}

/** Next segment to play after `index`, or null when the storyboard is done. */
export function nextSegmentIndex(index: number, itemCount: number): number | null {
  return index + 1 < itemCount ? index + 1 : null;
}
