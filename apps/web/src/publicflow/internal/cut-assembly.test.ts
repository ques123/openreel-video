import { describe, expect, it } from "vitest";
import type { Storyboard, StoryboardItem } from "@openreel/core";
import { assemblePublicCut, hasStoryboardTitle } from "./cut-assembly";

function item(overrides: Partial<StoryboardItem> = {}): StoryboardItem {
  return {
    clipId: "clip-1",
    fileName: "a.mp4",
    shotIndex: 0,
    inS: 0,
    outS: 5,
    role: "hook",
    why: "the strongest opening moment",
    thumbnailDataUrl: "data:image/jpeg;base64,AAA",
    ...overrides,
  };
}

describe("hasStoryboardTitle", () => {
  it("true for a non-blank title", () => {
    expect(hasStoryboardTitle({ title: "Golden Hour, Mostly", notes: null, items: [] })).toBe(true);
  });

  it("false for null", () => {
    expect(hasStoryboardTitle({ title: null, notes: null, items: [] })).toBe(false);
  });

  it("false for a whitespace-only title", () => {
    expect(hasStoryboardTitle({ title: "   ", notes: null, items: [] })).toBe(false);
  });
});

describe("assemblePublicCut", () => {
  it("maps each item to a PublicCutSegment (why + thumbnail passed through unchanged)", () => {
    const storyboard: Storyboard = {
      title: "Golden Hour, Mostly",
      notes: "internal editor note",
      items: [
        item({ clipId: "clip-1", inS: 0, outS: 4, why: "the hook" }),
        item({ clipId: "clip-2", inS: 10, outS: 16, why: "the payoff", thumbnailDataUrl: null }),
      ],
    };
    const cut = assemblePublicCut(storyboard, "Golden Hour, Mostly", null);
    expect(cut.segments).toEqual([
      { clipId: "clip-1", inS: 0, outS: 4, why: "the hook", thumbnailUrl: "data:image/jpeg;base64,AAA" },
      { clipId: "clip-2", inS: 10, outS: 16, why: "the payoff", thumbnailUrl: null },
    ]);
  });

  it("computes totalS as the sum of segment durations (storyboardDurationS)", () => {
    const storyboard: Storyboard = {
      title: "t",
      notes: null,
      items: [item({ inS: 0, outS: 4 }), item({ inS: 10, outS: 16 })],
    };
    expect(assemblePublicCut(storyboard, "t", null).totalS).toBeCloseTo(10); // 4 + 6
  });

  it("counts DISTINCT clips, not segment count (a clip reused for two segments counts once)", () => {
    const storyboard: Storyboard = {
      title: "t",
      notes: null,
      items: [
        item({ clipId: "clip-1", inS: 0, outS: 2 }),
        item({ clipId: "clip-1", inS: 5, outS: 7 }),
        item({ clipId: "clip-2", inS: 0, outS: 3 }),
      ],
    };
    expect(assemblePublicCut(storyboard, "t", null).clipCount).toBe(2);
    expect(assemblePublicCut(storyboard, "t", null).segments).toHaveLength(3);
  });

  it("carries the given title through unchanged (title resolution is the caller's job)", () => {
    const storyboard: Storyboard = { title: null, notes: null, items: [item()] };
    expect(assemblePublicCut(storyboard, "A Fallback Title", null).title).toBe("A Fallback Title");
  });

  it("passes musicTakes through unchanged (null when no music, {a,b} once Suno lands)", () => {
    const storyboard: Storyboard = { title: "t", notes: null, items: [item()] };
    expect(assemblePublicCut(storyboard, "t", null).musicTakes).toBeNull();
    const takes = { a: "https://a", b: "https://b" };
    expect(assemblePublicCut(storyboard, "t", takes).musicTakes).toBe(takes);
  });

  it("handles an empty storyboard (zero items) without throwing", () => {
    const storyboard: Storyboard = { title: "t", notes: null, items: [] };
    const cut = assemblePublicCut(storyboard, "t", null);
    expect(cut.segments).toEqual([]);
    expect(cut.totalS).toBe(0);
    expect(cut.clipCount).toBe(0);
  });
});
