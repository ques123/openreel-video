import { describe, expect, it } from "vitest";
import {
  CLIP_FADE_S,
  MUSIC_BED_VOLUME,
  MUSIC_DUCKING,
  compileStoryboardTimeline,
  duckingKeyframesForSpeech,
} from "../compile-timeline";
import { storyboardDurationS, type Storyboard, type StoryboardItem } from "../director-types";
import type { TranscriptSegment } from "../types";
import type { AutomationPoint } from "../../types/timeline";

const item = (over: Partial<StoryboardItem> = {}): StoryboardItem => ({
  clipId: "clip-a",
  fileName: "a.mp4",
  shotIndex: 0,
  inS: 0,
  outS: 5,
  role: "hook",
  why: "test",
  thumbnailDataUrl: null,
  ...over,
});

const board = (items: StoryboardItem[]): Storyboard => ({
  title: "Cut",
  notes: null,
  items,
});

/** clipId → mediaId resolver used across tests. */
const mediaIdOf = (clipId: string) => `media-${clipId}`;

/** Ducked bed gain per the MUSIC_DUCKING envelope. */
const DUCKED = MUSIC_BED_VOLUME * (1 - MUSIC_DUCKING.reduction);

/** Compare keyframes to [time, value] pairs with float tolerance. */
const expectPoints = (
  actual: readonly AutomationPoint[] | undefined,
  expected: Array<[number, number]>,
) => {
  expect(actual).toBeDefined();
  expect(actual).toHaveLength(expected.length);
  actual!.forEach((p, i) => {
    expect(p.time).toBeCloseTo(expected[i][0], 6);
    expect(p.value).toBeCloseTo(expected[i][1], 6);
  });
};

describe("compileStoryboardTimeline", () => {
  it("lays a 3-item storyboard out with cumulative startTimes and correct trims", () => {
    const sb = board([
      item({ clipId: "clip-a", inS: 2, outS: 5 }), // 3s
      item({ clipId: "clip-b", inS: 10, outS: 14.5 }), // 4.5s
      item({ clipId: "clip-c", inS: 0.5, outS: 2.5 }), // 2s
    ]);
    const { tracks, duration } = compileStoryboardTimeline(sb, mediaIdOf);

    expect(tracks).toHaveLength(1);
    const video = tracks[0];
    expect(video.type).toBe("video");
    expect(video.name).toBe("Video 1");
    expect(video.transitions).toEqual([]);
    expect(video.clips).toHaveLength(3);

    const [c0, c1, c2] = video.clips;
    expect(c0).toMatchObject({ startTime: 0, duration: 3, inPoint: 2, outPoint: 5 });
    expect(c1).toMatchObject({ startTime: 3, duration: 4.5, inPoint: 10, outPoint: 14.5 });
    expect(c2).toMatchObject({ startTime: 7.5, duration: 2, inPoint: 0.5, outPoint: 2.5 });
    expect(duration).toBe(9.5);

    // Every clip belongs to the video track and carries the plain defaults.
    for (const c of video.clips) {
      expect(c.trackId).toBe(video.id);
      expect(c.mediaId).toBe(mediaIdOf(sb.items[video.clips.indexOf(c)].clipId));
      expect(c.volume).toBe(1);
      expect(c.effects).toEqual([]);
      expect(c.audioEffects).toEqual([]);
      expect(c.keyframes).toEqual([]);
      expect(c.transform).toMatchObject({ opacity: 1, fitMode: "contain" });
    }
  });

  it("maps items sharing a clipId to the same mediaId but distinct clip ids", () => {
    const sb = board([
      item({ clipId: "clip-a", inS: 0, outS: 2 }),
      item({ clipId: "clip-a", inS: 5, outS: 8 }),
    ]);
    const { tracks } = compileStoryboardTimeline(sb, mediaIdOf);
    const [c0, c1] = tracks[0].clips;
    expect(c0.mediaId).toBe("media-clip-a");
    expect(c1.mediaId).toBe("media-clip-a");
    expect(c0.id).not.toBe(c1.id);
  });

  it("returns a duration equal to storyboardDurationS", () => {
    const sb = board([
      item({ inS: 1.25, outS: 4 }),
      item({ inS: 0, outS: 0.7 }),
      item({ inS: 30, outS: 33.3 }),
    ]);
    const { duration } = compileStoryboardTimeline(sb, mediaIdOf);
    expect(duration).toBeCloseTo(storyboardDurationS(sb), 10);
  });

  it("skips items with outS <= inS without corrupting subsequent startTimes", () => {
    const sb = board([
      item({ clipId: "clip-a", inS: 0, outS: 3 }), // 3s
      item({ clipId: "clip-b", inS: 5, outS: 5 }), // zero-length — skipped
      item({ clipId: "clip-c", inS: 8, outS: 4 }), // inverted — skipped
      item({ clipId: "clip-d", inS: 1, outS: 3 }), // 2s
    ]);
    const { tracks, duration } = compileStoryboardTimeline(sb, mediaIdOf);
    const clips = tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ mediaId: "media-clip-a", startTime: 0, duration: 3 });
    expect(clips[1]).toMatchObject({ mediaId: "media-clip-d", startTime: 3, duration: 2 });
    expect(duration).toBe(5);
  });

  it("gives every clip its own transform object (no shared nested state)", () => {
    const sb = board([
      item({ inS: 0, outS: 2 }),
      item({ inS: 2, outS: 4 }),
    ]);
    const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
      music: { mediaId: "media-music", durationS: 4 },
    });
    const [c0, c1] = tracks[0].clips;
    const audio = tracks[1].clips[0];
    expect(c0.transform).not.toBe(c1.transform);
    expect(c0.transform.position).not.toBe(c1.transform.position);
    expect(c0.transform).not.toBe(audio.transform);
    // Mutating one clip's transform must not bleed into another's.
    c0.transform.position.x = 99;
    c0.transform.scale.y = 2;
    expect(c1.transform.position.x).toBe(0);
    expect(c1.transform.scale.y).toBe(1);
    expect(audio.transform.position.x).toBe(0);
  });

  it("compiles an empty storyboard to one empty video track and duration 0", () => {
    const { tracks, duration } = compileStoryboardTimeline(board([]), mediaIdOf);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].type).toBe("video");
    expect(tracks[0].clips).toEqual([]);
    expect(duration).toBe(0);
  });

  describe("clip fades", () => {
    it("puts a CLIP_FADE_S in/out fade on every compiled clip, music included", () => {
      const sb = board([item({ inS: 0, outS: 4 }), item({ inS: 1, outS: 3 })]);
      const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 120 },
      });
      const all = [...tracks[0].clips, ...tracks[1].clips];
      expect(all.length).toBeGreaterThan(0);
      for (const c of all) {
        expect(c.fade).toEqual({ fadeIn: CLIP_FADE_S, fadeOut: CLIP_FADE_S });
      }
    });

    it("clamps the fade to half the duration on very short clips", () => {
      const sb = board([item({ inS: 0, outS: 0.04 })]); // 40ms clip
      const { tracks } = compileStoryboardTimeline(sb, mediaIdOf);
      expect(tracks[0].clips[0].fade?.fadeIn).toBeCloseTo(0.02, 10);
      expect(tracks[0].clips[0].fade?.fadeOut).toBeCloseTo(0.02, 10);
    });
  });

  describe("music bed", () => {
    it("matches the audition volume everywhere (0.35)", () => {
      expect(MUSIC_BED_VOLUME).toBe(0.35);
    });

    it("adds a single MUSIC_BED_VOLUME clip trimmed to the cut when the music is longer", () => {
      const sb = board([item({ inS: 0, outS: 4 }), item({ inS: 0, outS: 4 })]); // 8s cut
      const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 120 },
      });
      expect(tracks).toHaveLength(2);
      const audio = tracks[1];
      expect(audio.type).toBe("audio");
      expect(audio.name).toBe("Audio 1");
      expect(audio.clips).toHaveLength(1);
      expect(audio.clips[0]).toMatchObject({
        mediaId: "media-music",
        trackId: audio.id,
        startTime: 0,
        inPoint: 0,
        outPoint: 8,
        duration: 8,
        volume: MUSIC_BED_VOLUME,
      });
    });

    it("tiles shorter music end-to-end until it covers the full cut", () => {
      const sb = board([item({ inS: 0, outS: 10 })]); // 10s cut
      const { tracks, duration } = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 3 },
      });
      const clips = tracks[1].clips;
      expect(clips).toHaveLength(4);
      let cursor = 0;
      for (const c of clips) {
        expect(c.startTime).toBeCloseTo(cursor, 9);
        expect(c.inPoint).toBe(0); // each tile restarts the track
        expect(c.outPoint).toBeCloseTo(c.duration, 9);
        expect(c.volume).toBe(MUSIC_BED_VOLUME);
        cursor += c.duration;
      }
      expect(clips[3].duration).toBeCloseTo(1, 9); // last tile trimmed to fit
      expect(cursor).toBeCloseTo(duration, 9); // gapless coverage to the end
    });

    it("does not spawn a drift tile when the music divides the cut exactly", () => {
      const sb = board([item({ inS: 0, outS: 9 })]);
      const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 3 },
      });
      expect(tracks[1].clips).toHaveLength(3);
    });

    it("omits the music track when opts.music is absent", () => {
      const { tracks } = compileStoryboardTimeline(board([item()]), mediaIdOf);
      expect(tracks).toHaveLength(1);
    });

    it("omits the music track for degenerate inputs (empty cut, zero-length music)", () => {
      const withEmptyCut = compileStoryboardTimeline(board([]), mediaIdOf, {
        music: { mediaId: "media-music", durationS: 60 },
      });
      expect(withEmptyCut.tracks).toHaveLength(1);

      const withZeroMusic = compileStoryboardTimeline(board([item()]), mediaIdOf, {
        music: { mediaId: "media-music", durationS: 0 },
      });
      expect(withZeroMusic.tracks).toHaveLength(1);
    });
  });

  describe("duckingKeyframesForSpeech", () => {
    it("wraps a single span in the attack/duck/release envelope", () => {
      const points = duckingKeyframesForSpeech([{ startS: 2, endS: 4 }]);
      expectPoints(points, [
        [2 - MUSIC_DUCKING.attackS, MUSIC_BED_VOLUME],
        [2, DUCKED],
        [4, DUCKED],
        [4 + MUSIC_DUCKING.releaseS, MUSIC_BED_VOLUME],
      ]);
    });

    it("merges overlapping and near-adjacent spans (gap <= holdS) into one envelope", () => {
      const points = duckingKeyframesForSpeech([
        { startS: 5, endS: 6 }, // unsorted on purpose
        { startS: 2, endS: 4 },
        { startS: 3.5, endS: 4.8 }, // overlaps the 2–4 span
        { startS: 4.9, endS: 5.1 }, // 0.1s gap — under holdS, still merged
      ]);
      expectPoints(points, [
        [2 - MUSIC_DUCKING.attackS, MUSIC_BED_VOLUME],
        [2, DUCKED],
        [6, DUCKED],
        [6 + MUSIC_DUCKING.releaseS, MUSIC_BED_VOLUME],
      ]);
    });

    it("keeps spans with a gap over holdS as separate envelopes", () => {
      const points = duckingKeyframesForSpeech([
        { startS: 1, endS: 2 },
        { startS: 4, endS: 5 },
      ]);
      expect(points).toHaveLength(8);
      expectPoints(points.slice(0, 4), [
        [1 - MUSIC_DUCKING.attackS, MUSIC_BED_VOLUME],
        [1, DUCKED],
        [2, DUCKED],
        [2 + MUSIC_DUCKING.releaseS, MUSIC_BED_VOLUME],
      ]);
      expectPoints(points.slice(4), [
        [4 - MUSIC_DUCKING.attackS, MUSIC_BED_VOLUME],
        [4, DUCKED],
        [5, DUCKED],
        [5 + MUSIC_DUCKING.releaseS, MUSIC_BED_VOLUME],
      ]);
    });

    it("starts ducked when speech starts at t=0 (attack clamps, collision keeps the duck)", () => {
      const points = duckingKeyframesForSpeech([{ startS: 0, endS: 3 }]);
      expectPoints(points, [
        [0, DUCKED],
        [3, DUCKED],
        [3 + MUSIC_DUCKING.releaseS, MUSIC_BED_VOLUME],
      ]);
    });

    it("returns [] for empty and zero-length spans", () => {
      expect(duckingKeyframesForSpeech([])).toEqual([]);
      expect(duckingKeyframesForSpeech([{ startS: 2, endS: 2 }])).toEqual([]);
      expect(duckingKeyframesForSpeech([{ startS: 3, endS: 1 }])).toEqual([]);
    });

    it("is deterministic", () => {
      const spans = [
        { startS: 0.5, endS: 1.5 },
        { startS: 1.2, endS: 2.2 },
        { startS: 6, endS: 7 },
      ];
      expect(duckingKeyframesForSpeech(spans)).toEqual(duckingKeyframesForSpeech(spans));
    });
  });

  describe("music ducking in the compiled timeline", () => {
    const transcripts = (map: Record<string, TranscriptSegment[]>) => (clipId: string) =>
      map[clipId];

    it("maps source-clip transcript spans through the item trim into bed automation", () => {
      // Item plays source 10–20s at output 0–10s; speech at source 12–14s
      // lands at output 2–4s.
      const sb = board([item({ clipId: "clip-a", inS: 10, outS: 20 })]);
      const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 10 },
        transcriptOf: transcripts({ "clip-a": [{ t0: 12, t1: 14, text: "hi" }] }),
      });
      const bed = tracks[1].clips[0];
      expectPoints(bed.automation?.volume, [
        [0, MUSIC_BED_VOLUME],
        [2 - MUSIC_DUCKING.attackS, MUSIC_BED_VOLUME],
        [2, DUCKED],
        [4, DUCKED],
        [4 + MUSIC_DUCKING.releaseS, MUSIC_BED_VOLUME],
        [10, MUSIC_BED_VOLUME],
      ]);
      // Only the bed is ducked — source clips keep their live audio untouched.
      for (const c of tracks[0].clips) expect(c.automation).toBeUndefined();
    });

    it("ignores transcript segments outside the trim and clamps overhanging ones", () => {
      const sb = board([item({ clipId: "clip-a", inS: 0, outS: 5 })]);
      const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 5 },
        transcriptOf: transcripts({
          "clip-a": [
            { t0: 7, t1: 9, text: "outside the trim" },
            { t0: 4.5, t1: 6, text: "overhangs the out point" },
          ],
        }),
      });
      // Speech clamps to 4.5–5s; keyframes clamp to the 5s music clip bounds
      // (the 5.3s release point falls outside and is dropped at the edge).
      const auto = tracks[1].clips[0].automation?.volume;
      expectPoints(auto, [
        [0, MUSIC_BED_VOLUME],
        [4.5 - MUSIC_DUCKING.attackS, MUSIC_BED_VOLUME],
        [4.5, DUCKED],
        [5, DUCKED],
      ]);
      for (const p of auto!) {
        expect(p.time).toBeGreaterThanOrEqual(0);
        expect(p.time).toBeLessThanOrEqual(tracks[1].clips[0].duration);
      }
    });

    it("carries a duck ramp across tile seams via boundary samples", () => {
      // 10s cut over a 4s track → tiles [0,4) [4,8) [8,10); speech 3.5–4.5s
      // straddles the first seam.
      const sb = board([item({ clipId: "clip-a", inS: 0, outS: 10 })]);
      const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 4 },
        transcriptOf: transcripts({ "clip-a": [{ t0: 3.5, t1: 4.5, text: "hi" }] }),
      });
      const [tile1, tile2, tile3] = tracks[1].clips;
      expectPoints(tile1.automation?.volume, [
        [0, MUSIC_BED_VOLUME],
        [3.5 - MUSIC_DUCKING.attackS, MUSIC_BED_VOLUME],
        [3.5, DUCKED],
        [4, DUCKED], // seam boundary sample, mid-duck
      ]);
      expectPoints(tile2.automation?.volume, [
        [0, DUCKED], // picks the duck back up at the seam
        [0.5, DUCKED],
        [0.5 + MUSIC_DUCKING.releaseS, MUSIC_BED_VOLUME],
        [4, MUSIC_BED_VOLUME],
      ]);
      // Flat-at-base tiles carry no automation at all.
      expect(tile3.automation).toBeUndefined();
    });

    it("emits no automation without transcripts or without speech in the cut", () => {
      const sb = board([item({ clipId: "clip-a", inS: 0, outS: 5 })]);
      const noTranscript = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 5 },
      });
      expect(noTranscript.tracks[1].clips[0].automation).toBeUndefined();

      const silent = compileStoryboardTimeline(sb, mediaIdOf, {
        music: { mediaId: "media-music", durationS: 5 },
        transcriptOf: transcripts({ "clip-a": [] }),
      });
      expect(silent.tracks[1].clips[0].automation).toBeUndefined();
    });
  });
});
