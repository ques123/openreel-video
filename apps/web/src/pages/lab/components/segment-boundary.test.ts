import { describe, expect, it } from "vitest";
import {
  SEGMENT_END_EPSILON_S,
  nextSegmentIndex,
  pastSegmentEnd,
} from "./segment-boundary";

describe("pastSegmentEnd", () => {
  it("is false while safely inside the segment", () => {
    expect(pastSegmentEnd(3.0, 4.0)).toBe(false);
    expect(pastSegmentEnd(4.0 - SEGMENT_END_EPSILON_S - 0.001, 4.0)).toBe(false);
  });

  it("trips within epsilon of the out-point and at/after it", () => {
    expect(pastSegmentEnd(4.0 - SEGMENT_END_EPSILON_S, 4.0)).toBe(true);
    expect(pastSegmentEnd(4.0, 4.0)).toBe(true);
    expect(pastSegmentEnd(4.3, 4.0)).toBe(true);
  });

  it("handles sub-second segments (the refine-fidelity case)", () => {
    // 0.4s segment: 1.0 → 1.4. A 250ms poll could present up to ~1.7; the
    // per-frame check must trip within one frame of 1.4.
    expect(pastSegmentEnd(1.3, 1.4)).toBe(false);
    expect(pastSegmentEnd(1.36, 1.4)).toBe(true);
  });

  it("re-arms after scrubbing back inside the segment (negation is the re-arm test)", () => {
    expect(pastSegmentEnd(2.0, 4.0)).toBe(false);
  });
});

describe("nextSegmentIndex", () => {
  it("advances through the storyboard", () => {
    expect(nextSegmentIndex(0, 3)).toBe(1);
    expect(nextSegmentIndex(1, 3)).toBe(2);
  });

  it("returns null on the last segment", () => {
    expect(nextSegmentIndex(2, 3)).toBeNull();
    expect(nextSegmentIndex(0, 1)).toBeNull();
  });
});
