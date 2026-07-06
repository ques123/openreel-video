/**
 * Stage ⑥ compile: turn an approved Storyboard into real timeline tracks.
 *
 * Pure — no store access, no media I/O. The caller has already imported every
 * distinct source clip (and optionally the committed music track) into the
 * media library and hands us a clipId → mediaId resolver; we just lay the cut
 * out as one video track of hard-butted clips, plus an optional music track.
 */

import type { Storyboard } from "./director-types";
import type { TranscriptSegment } from "./types";
import type { AutomationPoint, Clip, Track, Transform } from "../types/timeline";

/**
 * Gain applied to the compiled music bed. MUST stay in sync with everywhere
 * the bed is auditioned before compile (lab preview modal, debug render) —
 * shipping the export at a different level than the audition is a bug.
 */
export const MUSIC_BED_VOLUME = 0.35;

/**
 * Audio fade in/out (seconds) applied to every compiled clip. Hard-butted
 * cuts otherwise start/stop mid-waveform and click; ~30ms is inaudible as a
 * fade but kills the discontinuity. Music tiles get it too, so the loop seam
 * doesn't pop.
 */
export const CLIP_FADE_S = 0.03;

/**
 * Music-ducking envelope, mirroring the manual editor's AudioDucker defaults
 * (AudioDuckingSection): duck the bed to 30% of its volume, 100ms attack,
 * 300ms release, merge speech gaps under 200ms. No `threshold` — compile
 * detects speech from the dossier transcript, not from RMS.
 */
export const MUSIC_DUCKING = {
  reduction: 0.7,
  attackS: 0.1,
  releaseS: 0.3,
  holdS: 0.2,
} as const;

/** A span of speech in OUTPUT (cut) time, seconds. */
export interface SpeechSpan {
  startS: number;
  endS: number;
}

/**
 * Matches the default transform applied by the "clip/add" action executor.
 * A fresh object per clip — clips must never share nested transform state.
 */
const defaultTransform = (): Transform => ({
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
  fitMode: "contain",
});

/**
 * Per-clip fade, clamped so fade-in and fade-out never overlap on very short
 * clips (the audio engine schedules them independently and would fight).
 */
const clipFade = (durationS: number): { fadeIn: number; fadeOut: number } => {
  const fadeS = Math.min(CLIP_FADE_S, durationS / 2);
  return { fadeIn: fadeS, fadeOut: fadeS };
};

/**
 * Map speech spans (cut time) to volume keyframes for the music bed: hold
 * `baseVolume` outside speech, ramp to `(1 - reduction) × baseVolume` during
 * it. Deterministic: spans in → keyframes out.
 *
 * Mirrors AudioDucker.generateDuckingKeyframes' range-merge + 4-point
 * envelope (../audio/volume-automation.ts) — that generator RMS-scans a
 * decoded AudioBuffer, which compile doesn't have, hence the duplicated
 * shape. One deliberate difference: same-time collisions keep the LAST
 * point, so speech starting at t=0 starts ducked instead of ramping down
 * across the whole first phrase.
 */
export function duckingKeyframesForSpeech(
  spans: readonly SpeechSpan[],
  baseVolume: number = MUSIC_BED_VOLUME,
): AutomationPoint[] {
  const sorted = spans
    .filter((s) => s.endS > s.startS)
    .sort((a, b) => a.startS - b.startS);
  if (sorted.length === 0) return [];

  const merged: SpeechSpan[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.startS <= last.endS + MUSIC_DUCKING.holdS) {
      last.endS = Math.max(last.endS, cur.endS);
    } else {
      merged.push({ ...cur });
    }
  }

  const ducked = baseVolume * (1 - MUSIC_DUCKING.reduction);
  const points: AutomationPoint[] = [];
  for (const range of merged) {
    points.push({
      time: Math.max(0, range.startS - MUSIC_DUCKING.attackS),
      value: baseVolume,
    });
    points.push({ time: range.startS, value: ducked });
    points.push({ time: range.endS, value: ducked });
    points.push({ time: range.endS + MUSIC_DUCKING.releaseS, value: baseVolume });
  }
  points.sort((a, b) => a.time - b.time);

  const out: AutomationPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(p.time - last.time) <= 0.001) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/**
 * Linear-interpolated value of a sorted keyframe curve at time t — same
 * semantics as the playback graph: base volume before the first point, hold
 * the last value after it.
 */
function valueAt(
  points: readonly AutomationPoint[],
  t: number,
  base: number,
): number {
  if (points.length === 0 || t < points[0].time) return base;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (t >= b.time) continue;
    const span = b.time - a.time;
    if (span <= 1e-9) return b.value;
    return a.value + ((b.value - a.value) * (t - a.time)) / span;
  }
  return points[points.length - 1].value;
}

/**
 * Cut the global (cut-time) ducking curve down to one music tile's window,
 * re-based to clip-relative time. Boundary samples are inserted so a ramp
 * crossing a tile seam carries its mid-ramp value over — the playback graph
 * holds plain base volume outside a clip's own points. Returns undefined
 * when the window is flat at base volume (no automation needed).
 */
function sliceAutomation(
  points: readonly AutomationPoint[],
  fromS: number,
  toS: number,
  base: number,
): AutomationPoint[] | undefined {
  if (points.length === 0) return undefined;
  const sliced: AutomationPoint[] = [
    { time: 0, value: valueAt(points, fromS, base) },
  ];
  for (const p of points) {
    if (p.time <= fromS + 1e-6 || p.time >= toS - 1e-6) continue;
    sliced.push({ time: p.time - fromS, value: p.value });
  }
  sliced.push({ time: toS - fromS, value: valueAt(points, toS, base) });
  if (sliced.every((p) => Math.abs(p.value - base) < 1e-6)) return undefined;
  return sliced;
}

/**
 * Compile a storyboard into timeline tracks (Stage ⑥ of the perception
 * funnel: approved cut → editable project).
 *
 * - One "video" track with one clip per storyboard item, in playback order:
 *   `inPoint`/`outPoint` are the item's trim range, `startTime` is the
 *   cumulative sum of prior item durations (hard cuts, no transitions).
 * - With `opts.music`, one "audio" track of the committed music at
 *   MUSIC_BED_VOLUME, tiled end-to-end (each tile restarts at inPoint 0)
 *   until it covers the full cut, the last tile trimmed to fit. Degenerate
 *   inputs (empty cut, zero-length music) compile without the track.
 * - With `opts.transcriptOf` too, transcript speech spans duck the bed
 *   (per-tile volume automation, MUSIC_DUCKING envelope).
 * - Every clip carries a ~30ms audio fade in/out (CLIP_FADE_S).
 *
 * @param storyboard        Validated storyboard; item order = playback order.
 * @param mediaIdOf         clipId → mediaId of the already-imported source
 *                          file. Must resolve every clipId in the storyboard.
 * @param opts.music        Already-imported committed music track, if any.
 * @param opts.transcriptOf clipId → dossier transcript (source-clip time);
 *                          enables music ducking under speech.
 * @returns Tracks plus the total cut duration in seconds.
 */
export function compileStoryboardTimeline(
  storyboard: Storyboard,
  mediaIdOf: (clipId: string) => string,
  opts?: {
    music?: { mediaId: string; durationS: number };
    transcriptOf?: (clipId: string) => TranscriptSegment[] | undefined;
  },
): { tracks: Track[]; duration: number } {
  const videoTrackId = `track-${crypto.randomUUID()}`;
  const clips: Clip[] = [];
  const speech: SpeechSpan[] = [];
  const wantDucking = Boolean(opts?.music && opts?.transcriptOf);
  let cursorS = 0;

  for (const item of storyboard.items) {
    // A malformed stored storyboard could carry outS <= inS — skip such items
    // entirely (no clip, no cursor advance) rather than emit negative-duration
    // clips with overlapping startTimes.
    const durationS = Math.max(0, item.outS - item.inS);
    if (durationS <= 0) continue;
    if (wantDucking) {
      // Source-clip transcript time → output (cut) time, clamped to the trim.
      for (const seg of opts?.transcriptOf?.(item.clipId) ?? []) {
        const startS = Math.max(seg.t0, item.inS);
        const endS = Math.min(seg.t1, item.outS);
        if (endS <= startS) continue;
        speech.push({
          startS: cursorS + (startS - item.inS),
          endS: cursorS + (endS - item.inS),
        });
      }
    }
    clips.push({
      id: crypto.randomUUID(),
      mediaId: mediaIdOf(item.clipId),
      trackId: videoTrackId,
      startTime: cursorS,
      duration: durationS,
      inPoint: item.inS,
      outPoint: item.outS,
      effects: [],
      audioEffects: [],
      transform: defaultTransform(),
      volume: 1,
      fade: clipFade(durationS),
      keyframes: [],
    });
    cursorS += durationS;
  }

  const tracks: Track[] = [
    {
      id: videoTrackId,
      type: "video",
      name: "Video 1",
      clips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    },
  ];

  if (opts?.music && opts.music.durationS > 0 && cursorS > 0) {
    const audioTrackId = `track-${crypto.randomUUID()}`;
    const ducking = duckingKeyframesForSpeech(speech);
    const musicClips: Clip[] = [];
    // Tile the bed until it covers the cut (epsilon guards float-sum drift
    // from spawning a ~0-length final tile).
    for (let k = 0; k * opts.music.durationS < cursorS - 1e-6; k += 1) {
      const tileStartS = k * opts.music.durationS;
      const tileDurS = Math.min(opts.music.durationS, cursorS - tileStartS);
      const automation = sliceAutomation(
        ducking,
        tileStartS,
        tileStartS + tileDurS,
        MUSIC_BED_VOLUME,
      );
      musicClips.push({
        id: crypto.randomUUID(),
        mediaId: opts.music.mediaId,
        trackId: audioTrackId,
        startTime: tileStartS,
        duration: tileDurS,
        inPoint: 0,
        outPoint: tileDurS,
        effects: [],
        audioEffects: [],
        transform: defaultTransform(),
        volume: MUSIC_BED_VOLUME,
        fade: clipFade(tileDurS),
        ...(automation ? { automation: { volume: automation } } : {}),
        keyframes: [],
      });
    }
    tracks.push({
      id: audioTrackId,
      type: "audio",
      name: "Audio 1",
      clips: musicClips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  return { tracks, duration: cursorS };
}
