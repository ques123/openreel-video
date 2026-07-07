/**
 * Pure helpers for TranscriptCompareModal, kept DOM-free for tests (jsdom
 * has no real <video> timeupdate/seek behavior worth exercising). The video
 * element, its timeupdate listener, and the autoscroll-on-active-change
 * effect all stay in the component — this module only computes what they
 * need to decide.
 */

/** Minimal shape both local (TranscriptSegment) and cloud segments satisfy. */
interface TimedSegment {
  t0: number;
  t1: number;
}

/**
 * Default tolerance around a segment's [t0, t1) bounds, in seconds — absorbs
 * float time math and the ~250ms granularity of a real timeupdate event so
 * playback doesn't flicker to "no active segment" right at a boundary.
 * Mirrors SEGMENT_END_EPSILON_S's role in segment-boundary.ts.
 */
export const ACTIVE_SEGMENT_EPSILON_S = 0.05;

/**
 * Index of the segment covering time `t` (inclusive start, exclusive end,
 * widened by `epsilonS` on both edges), or -1 when `t` falls in a real gap
 * between segments (e.g. silence) — a gap wider than 2×epsilon around it, so
 * "no active segment" only ever means an actual pause, never boundary noise.
 * Assumes `segments` is sorted ascending by t0 (true of every transcript this
 * app produces), which lets the scan stop as soon as `t` is before a
 * segment's (widened) start.
 */
export function activeSegmentIndex(
  segments: TimedSegment[],
  t: number,
  epsilonS: number = ACTIVE_SEGMENT_EPSILON_S,
): number {
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (t < s.t0 - epsilonS) break; // sorted ascending — no later segment can match either
    if (t < s.t1 + epsilonS) return i;
  }
  return -1;
}

/** 0 -> "0:00.0", 65.25 -> "1:05.3". Unpadded minutes, one decimal on seconds. */
export function fmtSegTime(s: number): string {
  const total = Math.max(0, s);
  const m = Math.floor(total / 60);
  const sec = total - m * 60;
  // Rare float edge (e.g. 59.96 -> "60.0"): bump into the next minute instead
  // of ever displaying an out-of-range seconds value.
  if (sec >= 59.95) return `${m + 1}:00.0`;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

/** "10s billed", "1m 5s billed" — Groq's per-request-floor billing, human scale. */
export function fmtBilledDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s billed` : `${sec}s billed`;
}

/**
 * Word count from segment text — the fallback when no word-level array
 * exists (always true for the local column; true for a cloud run whose
 * response omitted word timestamps). Blank/whitespace-only segments count 0.
 */
export function countWordsFromText(segments: { text: string }[]): number {
  return segments.reduce((sum, s) => {
    const trimmed = s.text.trim();
    return sum + (trimmed ? trimmed.split(/\s+/).length : 0);
  }, 0);
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Exact-cost/compute stats a cloud transcription column's footer appends. */
export interface CloudFooterMeta {
  billedSeconds: number;
  costUSD: number;
  ms: number;
}

/**
 * Builds one column's footer line: "N segments · M words" alone for local,
 * or with the cloud run's exact billed-seconds/cost/compute appended.
 * `wordCount` should be the provider's word-level count when known (more
 * exact than a text split — e.g. cloudTranscript.words?.length); omit/null to
 * derive it from `segments` via countWordsFromText instead.
 */
export function fmtColumnFooter(
  segments: { text: string }[],
  wordCount?: number | null,
  cloud?: CloudFooterMeta,
): string {
  const words = wordCount ?? countWordsFromText(segments);
  const base = `${pluralize(segments.length, "segment")} · ${pluralize(words, "word")}`;
  if (!cloud) return base;
  return `${base} · ${fmtBilledDuration(cloud.billedSeconds)} · $${cloud.costUSD.toFixed(4)} · ${Math.round(cloud.ms)}ms`;
}
