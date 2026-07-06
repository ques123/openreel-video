import { describe, expect, it } from "vitest";
import { compileStoryboardTimeline } from "../compile-timeline";
import { storyboardDurationS, type Storyboard, type StoryboardItem } from "../director-types";

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

  it("adds a music track trimmed to the cut when the music is longer", () => {
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
      volume: 1,
    });
  });

  it("keeps the full music length when it is shorter than the cut", () => {
    const sb = board([item({ inS: 0, outS: 10 })]); // 10s cut
    const { tracks } = compileStoryboardTimeline(sb, mediaIdOf, {
      music: { mediaId: "media-music", durationS: 6.5 },
    });
    expect(tracks[1].clips[0]).toMatchObject({ outPoint: 6.5, duration: 6.5 });
  });

  it("omits the music track when opts.music is absent", () => {
    const { tracks } = compileStoryboardTimeline(board([item()]), mediaIdOf);
    expect(tracks).toHaveLength(1);
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
});
