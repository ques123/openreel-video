import { describe, expect, it } from "vitest";
import {
  SEGMENT_END_EPSILON_S,
  cutRelativeRanges,
  nextSegmentIndex,
  pastSegmentEnd,
  segmentIndexAtCutTime,
} from "./player-advance";

describe("pastSegmentEnd", () => {
  it("is false well before the out-point", () => {
    expect(pastSegmentEnd(5, 10)).toBe(false);
  });

  it("trips within the epsilon window before the out-point", () => {
    expect(pastSegmentEnd(10 - SEGMENT_END_EPSILON_S, 10)).toBe(true);
    expect(pastSegmentEnd(10 - SEGMENT_END_EPSILON_S - 0.001, 10)).toBe(false);
  });

  it("is true at and past the out-point", () => {
    expect(pastSegmentEnd(10, 10)).toBe(true);
    expect(pastSegmentEnd(11, 10)).toBe(true);
  });
});

describe("nextSegmentIndex", () => {
  it("advances while segments remain", () => {
    expect(nextSegmentIndex(0, 3)).toBe(1);
    expect(nextSegmentIndex(1, 3)).toBe(2);
  });

  it("returns null once the last segment is reached", () => {
    expect(nextSegmentIndex(2, 3)).toBeNull();
  });
});

describe("cutRelativeRanges", () => {
  it("lays out cumulative cut-time ranges from source in/out pairs", () => {
    const ranges = cutRelativeRanges([
      { inS: 10, outS: 17 }, // 7s
      { inS: 40, outS: 44 }, // 4s
      { inS: 0, outS: 5 }, // 5s
    ]);
    expect(ranges).toEqual([
      { startS: 0, endS: 7 },
      { startS: 7, endS: 11 },
      { startS: 11, endS: 16 },
    ]);
  });

  it("skips no segments but tolerates a zero-length one without going negative", () => {
    const ranges = cutRelativeRanges([{ inS: 5, outS: 5 }, { inS: 0, outS: 3 }]);
    expect(ranges).toEqual([
      { startS: 0, endS: 0 },
      { startS: 0, endS: 3 },
    ]);
  });

  it("returns an empty array for an empty cut", () => {
    expect(cutRelativeRanges([])).toEqual([]);
  });
});

describe("segmentIndexAtCutTime", () => {
  const ranges = cutRelativeRanges([
    { inS: 0, outS: 7 },
    { inS: 0, outS: 4 },
    { inS: 0, outS: 5 },
  ]); // [0,7) [7,11) [11,16)

  it("finds the segment containing a cut-relative time", () => {
    expect(segmentIndexAtCutTime(0, ranges)).toBe(0);
    expect(segmentIndexAtCutTime(6.9, ranges)).toBe(0);
    expect(segmentIndexAtCutTime(7, ranges)).toBe(1);
    expect(segmentIndexAtCutTime(12, ranges)).toBe(2);
  });

  it("clamps to the last segment when past the end", () => {
    expect(segmentIndexAtCutTime(999, ranges)).toBe(2);
  });

  it("returns 0 for an empty cut rather than throwing", () => {
    expect(segmentIndexAtCutTime(5, [])).toBe(0);
  });
});
