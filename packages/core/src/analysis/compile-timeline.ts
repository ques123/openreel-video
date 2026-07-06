/**
 * Stage ⑥ compile: turn an approved Storyboard into real timeline tracks.
 *
 * Pure — no store access, no media I/O. The caller has already imported every
 * distinct source clip (and optionally the committed music track) into the
 * media library and hands us a clipId → mediaId resolver; we just lay the cut
 * out as one video track of hard-butted clips, plus an optional music track.
 */

import type { Storyboard } from "./director-types";
import type { Clip, Track, Transform } from "../types/timeline";

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
 * Compile a storyboard into timeline tracks (Stage ⑥ of the perception
 * funnel: approved cut → editable project).
 *
 * - One "video" track with one clip per storyboard item, in playback order:
 *   `inPoint`/`outPoint` are the item's trim range, `startTime` is the
 *   cumulative sum of prior item durations (hard cuts, no transitions).
 * - With `opts.music`, one "audio" track holding a single clip at time 0,
 *   trimmed to `min(music.durationS, cut duration)`.
 *
 * @param storyboard   Validated storyboard; item order = playback order.
 * @param mediaIdOf    clipId → mediaId of the already-imported source file.
 *                     Must resolve every clipId in the storyboard.
 * @param opts.music   Already-imported committed music track, if any.
 * @returns Tracks plus the total cut duration in seconds.
 */
export function compileStoryboardTimeline(
  storyboard: Storyboard,
  mediaIdOf: (clipId: string) => string,
  opts?: { music?: { mediaId: string; durationS: number } },
): { tracks: Track[]; duration: number } {
  const videoTrackId = `track-${crypto.randomUUID()}`;
  const clips: Clip[] = [];
  let cursorS = 0;

  for (const item of storyboard.items) {
    // A malformed stored storyboard could carry outS <= inS — skip such items
    // entirely (no clip, no cursor advance) rather than emit negative-duration
    // clips with overlapping startTimes.
    const durationS = Math.max(0, item.outS - item.inS);
    if (durationS <= 0) continue;
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

  if (opts?.music) {
    const audioTrackId = `track-${crypto.randomUUID()}`;
    const musicDurationS = Math.min(opts.music.durationS, cursorS);
    tracks.push({
      id: audioTrackId,
      type: "audio",
      name: "Audio 1",
      clips: [
        {
          id: crypto.randomUUID(),
          mediaId: opts.music.mediaId,
          trackId: audioTrackId,
          startTime: 0,
          duration: musicDurationS,
          inPoint: 0,
          outPoint: musicDurationS,
          effects: [],
          audioEffects: [],
          transform: defaultTransform(),
          volume: 1,
          keyframes: [],
        },
      ],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }

  return { tracks, duration: cursorS };
}
