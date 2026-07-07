import { describe, expect, it } from "vitest";
import {
  ACTIVE_SEGMENT_EPSILON_S,
  activeSegmentIndex,
  countWordsFromText,
  fmtBilledDuration,
  fmtColumnFooter,
  fmtSegTime,
} from "./transcript-compare";

describe("activeSegmentIndex", () => {
  const segments = [
    { t0: 0, t1: 2 },
    { t0: 2, t1: 4 },
    { t0: 8, t1: 10 },
  ];

  it("finds the segment containing t", () => {
    expect(activeSegmentIndex(segments, 0)).toBe(0);
    expect(activeSegmentIndex(segments, 1.5)).toBe(0);
    expect(activeSegmentIndex(segments, 2.5)).toBe(1);
    expect(activeSegmentIndex(segments, 9)).toBe(2);
  });

  it("returns -1 before the first segment", () => {
    expect(activeSegmentIndex(segments, -1)).toBe(-1);
  });

  it("returns -1 after the last segment", () => {
    expect(activeSegmentIndex(segments, 20)).toBe(-1);
  });

  it("returns -1 in a real gap between segments (well outside epsilon)", () => {
    // Gap is [4, 8): comfortably wider than 2*epsilon on either side.
    expect(activeSegmentIndex(segments, 6)).toBe(-1);
  });

  it("does not flicker to none right at a shared boundary (adjacent segments)", () => {
    // Segment 0 ends exactly where segment 1 begins (t=2) — no real gap.
    // The epsilon-widened ranges overlap right at the boundary; the first
    // (earlier) match wins, so the highlight stays on segment 0 until t is
    // unambiguously past its end, then moves cleanly to segment 1.
    expect(activeSegmentIndex(segments, 2 - 0.001)).toBe(0);
    expect(activeSegmentIndex(segments, 2)).toBe(0);
    expect(activeSegmentIndex(segments, 2 + ACTIVE_SEGMENT_EPSILON_S + 0.001)).toBe(1);
  });

  it("tolerates float noise within epsilon of a boundary", () => {
    expect(activeSegmentIndex(segments, 4 + ACTIVE_SEGMENT_EPSILON_S / 2)).toBe(1);
    expect(activeSegmentIndex(segments, 8 - ACTIVE_SEGMENT_EPSILON_S / 2)).toBe(2);
  });

  it("respects a custom epsilon", () => {
    // With a tighter epsilon, a value just past t1 no longer matches.
    expect(activeSegmentIndex(segments, 2.02, 0.01)).toBe(1);
    expect(activeSegmentIndex([{ t0: 0, t1: 2 }], 2.02, 0.01)).toBe(-1);
  });

  it("returns -1 for an empty segment list", () => {
    expect(activeSegmentIndex([], 5)).toBe(-1);
  });
});

describe("fmtSegTime", () => {
  it("formats sub-minute times unpadded on minutes, one decimal on seconds", () => {
    expect(fmtSegTime(0)).toBe("0:00.0");
    expect(fmtSegTime(5)).toBe("0:05.0");
    expect(fmtSegTime(45.6)).toBe("0:45.6");
  });

  it("formats minutes past the first", () => {
    expect(fmtSegTime(65.25)).toBe("1:05.3");
    expect(fmtSegTime(125.4)).toBe("2:05.4");
  });

  it("clamps negative input to zero", () => {
    expect(fmtSegTime(-3)).toBe("0:00.0");
  });

  it("rolls over into the next minute instead of showing 60.0 seconds", () => {
    expect(fmtSegTime(119.96)).toBe("2:00.0");
  });
});

describe("fmtBilledDuration", () => {
  it("formats sub-minute durations without a minutes component", () => {
    expect(fmtBilledDuration(0)).toBe("0s billed");
    expect(fmtBilledDuration(10)).toBe("10s billed");
  });

  it("formats minutes + seconds", () => {
    expect(fmtBilledDuration(65)).toBe("1m 5s billed");
    expect(fmtBilledDuration(600)).toBe("10m 0s billed");
  });

  it("rounds to the nearest second", () => {
    expect(fmtBilledDuration(59.6)).toBe("1m 0s billed");
  });
});

describe("countWordsFromText", () => {
  it("counts words across segments", () => {
    expect(countWordsFromText([{ text: "hello world" }, { text: "one" }])).toBe(3);
  });

  it("treats blank/whitespace-only segments as zero words", () => {
    expect(countWordsFromText([{ text: "  " }, { text: "" }])).toBe(0);
  });

  it("collapses runs of whitespace", () => {
    expect(countWordsFromText([{ text: "a   b\tc\nd" }])).toBe(4);
  });

  it("returns 0 for an empty list", () => {
    expect(countWordsFromText([])).toBe(0);
  });
});

describe("fmtColumnFooter", () => {
  const segments = [{ text: "hello world" }, { text: "foo" }];

  it("builds the local footer: segment + word count only", () => {
    expect(fmtColumnFooter(segments)).toBe("2 segments · 3 words");
  });

  it("singularizes counts of 1", () => {
    expect(fmtColumnFooter([{ text: "hi" }])).toBe("1 segment · 1 word");
  });

  it("prefers an explicit word count over splitting text", () => {
    expect(fmtColumnFooter(segments, 10)).toBe("2 segments · 10 words");
  });

  it("falls back to text-splitting when wordCount is null/undefined", () => {
    expect(fmtColumnFooter(segments, null)).toBe("2 segments · 3 words");
    expect(fmtColumnFooter(segments, undefined)).toBe("2 segments · 3 words");
  });

  it("appends exact cloud billing stats when provided", () => {
    expect(
      fmtColumnFooter(segments, 10, { billedSeconds: 65, costUSD: 0.0023, ms: 842 }),
    ).toBe("2 segments · 10 words · 1m 5s billed · $0.0023 · 842ms");
  });

  it("formats costUSD to 4 decimals even for very small amounts", () => {
    expect(
      fmtColumnFooter([], 0, { billedSeconds: 10, costUSD: 0.0001111, ms: 100 }),
    ).toBe("0 segments · 0 words · 10s billed · $0.0001 · 100ms");
  });
});
