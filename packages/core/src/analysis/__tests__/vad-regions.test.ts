import { describe, expect, it } from "vitest";
import {
  VAD_MERGE_GAP_S,
  VAD_MIN_REGION_S,
  VAD_PAD_S,
  dropShortRegions,
  mergeRegions,
  offsetSegments,
  padRegions,
  processVadRegions,
  splitLongRegions,
  type VadRegion,
} from "../vad-regions";
import type { TranscriptSegment } from "../types";

function region(start: number, end: number): VadRegion {
  return { start, end };
}

// mergeRegions/dropShortRegions/splitLongRegions never synthesize a NEW
// numeric value for start/end (merge copies an input value via Math.max of
// two inputs; split/pad add/subtract from inputs). Tests below stick to
// integers (or exact halves) wherever a result comes from arithmetic, so
// `toEqual` is safe; a couple of tests exercising the real 0.2/0.3/0.25
// defaults use `toBeCloseTo` instead, since those constants don't combine
// into exact doubles (e.g. 1.35 - 0.2 !== 1.15 bit-for-bit).

describe("mergeRegions", () => {
  it("returns [] for empty input", () => {
    expect(mergeRegions([])).toEqual([]);
  });

  it("leaves a single region untouched", () => {
    expect(mergeRegions([region(1, 2)])).toEqual([region(1, 2)]);
  });

  it("merges regions separated by a gap smaller than gapS", () => {
    // gap = 0.2 < default 0.3
    const merged = mergeRegions([region(0, 1), region(1.2, 2)]);
    expect(merged).toEqual([region(0, 2)]);
  });

  it("keeps regions separate when the gap equals gapS exactly (strict <)", () => {
    const merged = mergeRegions([region(0, 1), region(1.3, 2)], 0.3);
    expect(merged).toEqual([region(0, 1), region(1.3, 2)]);
  });

  it("keeps regions separate when the gap exceeds gapS", () => {
    const merged = mergeRegions([region(0, 1), region(1.5, 2)], 0.3);
    expect(merged).toEqual([region(0, 1), region(1.5, 2)]);
  });

  it("merges overlapping regions", () => {
    const merged = mergeRegions([region(0, 2), region(1, 3)]);
    expect(merged).toEqual([region(0, 3)]);
  });

  it("merges touching regions (gap exactly 0)", () => {
    const merged = mergeRegions([region(0, 1), region(1, 2)]);
    expect(merged).toEqual([region(0, 2)]);
  });

  it("sorts unsorted input before merging", () => {
    const merged = mergeRegions([region(5, 6), region(0, 1)]);
    expect(merged).toEqual([region(0, 1), region(5, 6)]);
  });

  it("chains a merge across more than two regions", () => {
    const merged = mergeRegions([region(0, 1), region(1.1, 2), region(2.1, 3)], 0.3);
    expect(merged).toEqual([region(0, 3)]);
  });

  it("keeps a later region's larger end when it fully contains the merge point", () => {
    // region B is nested inside what would be the merged span of A alone.
    const merged = mergeRegions([region(0, 5), region(1, 2)], 0.3);
    expect(merged).toEqual([region(0, 5)]);
  });
});

describe("padRegions", () => {
  it("pads both sides by padS", () => {
    expect(padRegions([region(2, 3)], 1, 100)).toEqual([region(1, 4)]);
  });

  it("clamps the start at 0", () => {
    expect(padRegions([region(0.5, 1)], 1, 100)).toEqual([region(0, 2)]);
  });

  it("clamps the end at totalDurationS", () => {
    expect(padRegions([region(9, 9.5)], 1, 10)).toEqual([region(8, 10)]);
  });

  it("does not merge regions padding brings into overlap — returns each independently", () => {
    const padded = padRegions([region(0, 1), region(1.5, 2)], 1, 100);
    expect(padded).toEqual([region(0, 2), region(0.5, 3)]);
  });

  it("uses the exported default padS and no clamp when omitted", () => {
    const [result] = padRegions([region(5, 6)]);
    expect(result.start).toBeCloseTo(5 - VAD_PAD_S, 9);
    expect(result.end).toBeCloseTo(6 + VAD_PAD_S, 9);
  });
});

describe("dropShortRegions", () => {
  it("drops regions strictly shorter than minRegionS", () => {
    expect(dropShortRegions([region(0, 2)], 3)).toEqual([]);
  });

  it("keeps a region exactly at minRegionS", () => {
    expect(dropShortRegions([region(0, 0.25)], 0.25)).toEqual([region(0, 0.25)]);
  });

  it("keeps regions longer than minRegionS", () => {
    expect(dropShortRegions([region(0, 1)], 0.25)).toEqual([region(0, 1)]);
  });

  it("uses the exported default when omitted", () => {
    expect(VAD_MIN_REGION_S).toBeGreaterThan(0);
    expect(dropShortRegions([region(0, VAD_MIN_REGION_S / 2)])).toEqual([]);
  });
});

describe("splitLongRegions", () => {
  it("leaves a region shorter than maxRegionS untouched", () => {
    expect(splitLongRegions([region(0, 100)], 600)).toEqual([region(0, 100)]);
  });

  it("leaves a region exactly at maxRegionS untouched (not split)", () => {
    expect(splitLongRegions([region(10, 610)], 600)).toEqual([region(10, 610)]);
  });

  it("splits a region slightly over maxRegionS into two pieces", () => {
    const split = splitLongRegions([region(0, 620)], 600);
    expect(split).toEqual([region(0, 600), region(600, 620)]);
  });

  it("splits a much longer region into several maxRegionS pieces plus a remainder", () => {
    const split = splitLongRegions([region(100, 1500)], 600);
    // 1500 - 100 = 1400 total -> 600 + 600 + 200
    expect(split).toEqual([region(100, 700), region(700, 1300), region(1300, 1500)]);
  });

  it("offsets split boundaries by the region's own start, not from 0", () => {
    const split = splitLongRegions([region(950, 1950)], 600);
    expect(split).toEqual([region(950, 1550), region(1550, 1950)]);
  });

  it("splits multiple regions independently, preserving order", () => {
    const split = splitLongRegions([region(0, 50), region(0, 1300)], 600);
    expect(split).toEqual([region(0, 50), region(0, 600), region(600, 1200), region(1200, 1300)]);
  });

  it("is a no-op when maxRegionS is non-positive (defensive guard)", () => {
    expect(splitLongRegions([region(0, 1000)], 0)).toEqual([region(0, 1000)]);
  });
});

describe("processVadRegions", () => {
  const baseOpts = { totalDurationS: 1000, maxRegionS: 600 };

  it("returns [] for empty raw input", () => {
    expect(processVadRegions([], baseOpts)).toEqual([]);
  });

  it("merges close raw regions before padding", () => {
    const result = processVadRegions([region(1, 2), region(2.5, 3)], {
      ...baseOpts,
      mergeGapS: 1, // 0.5s gap merges
      padS: 0,
    });
    expect(result).toEqual([region(1, 3)]);
  });

  it("pads before dropping, so a short blip survives via padding", () => {
    // Raw region is 1 unit long; minRegionS=4 would drop it outright, but
    // padS=2 on both sides grows it to 5, clearing the floor.
    const result = processVadRegions([region(5, 6)], {
      ...baseOpts,
      mergeGapS: 0,
      padS: 2,
      minRegionS: 4,
    });
    expect(result).toEqual([region(3, 8)]);
  });

  it("drops a region that stays under the floor when padding can't rescue it", () => {
    const result = processVadRegions([region(5, 6)], {
      ...baseOpts,
      mergeGapS: 0,
      padS: 0,
      minRegionS: 4,
    });
    expect(result).toEqual([]);
  });

  it("re-merges regions that padding brings into contact (no overlap in output)", () => {
    // Raw regions with a gap of 3 (ABOVE mergeGapS=2, so they do NOT merge
    // pre-pad). Padding by 2 on each side removes 4 of gap, turning the
    // 3-unit gap negative (an overlap) — the pipeline must recoalesce these
    // into one non-overlapping region.
    const result = processVadRegions([region(10, 20), region(23, 30)], {
      ...baseOpts,
      mergeGapS: 2,
      padS: 2,
      minRegionS: 0,
    });
    expect(result).toEqual([region(8, 32)]);
  });

  it("clamps padding at the clip start and end", () => {
    const result = processVadRegions([region(0.5, 5), region(996, 999.5)], {
      ...baseOpts,
      mergeGapS: 0,
      padS: 2,
      minRegionS: 0,
    });
    expect(result[0].start).toBe(0);
    expect(result[result.length - 1].end).toBe(1000);
  });

  it("splits a very long region at maxRegionS after pad/drop", () => {
    // totalDurationS raised to 2000 so the (padS: 0) pad step's end-clamp
    // doesn't truncate this deliberately-long 1400-unit raw region.
    const result = processVadRegions([region(0, 1400)], {
      totalDurationS: 2000,
      maxRegionS: 600,
      mergeGapS: 0,
      padS: 0,
      minRegionS: 0,
    });
    expect(result).toEqual([region(0, 600), region(600, 1200), region(1200, 1400)]);
  });

  it("honors custom mergeGapS/padS/minRegionS overrides together", () => {
    const result = processVadRegions([region(0, 1), region(2, 3)], {
      ...baseOpts,
      mergeGapS: 2, // 1-unit gap now merges
      padS: 0,
      minRegionS: 0,
    });
    expect(result).toEqual([region(0, 3)]);
  });

  it("uses the exported defaults when merge/pad/min are omitted", () => {
    // Raw 0.05s blip; the DEFAULT pad (0.2 each side) grows it to ~0.45s,
    // clearing the default 0.25s floor — same behavior as the custom-opts
    // "survives via padding" test above, exercising the real defaults.
    const [result] = processVadRegions([region(10, 10.05)], baseOpts);
    expect(result.start).toBeCloseTo(10 - VAD_PAD_S, 9);
    expect(result.end).toBeCloseTo(10.05 + VAD_PAD_S, 9);
  });
});

describe("offsetSegments", () => {
  const segs: TranscriptSegment[] = [
    { t0: 0, t1: 1, text: "hello" },
    { t0: 1.5, t1: 2.5, text: "world" },
  ];

  it("shifts every segment's t0/t1 by offsetS", () => {
    expect(offsetSegments(segs, 100)).toEqual([
      { t0: 100, t1: 101, text: "hello" },
      { t0: 101.5, t1: 102.5, text: "world" },
    ]);
  });

  it("returns the SAME array reference when offsetS is 0 (no-op fast path)", () => {
    expect(offsetSegments(segs, 0)).toBe(segs);
  });

  it("does not mutate the input array", () => {
    const copy = segs.map((s) => ({ ...s }));
    offsetSegments(segs, 50);
    expect(segs).toEqual(copy);
  });

  it("handles an empty segment list", () => {
    expect(offsetSegments([], 42)).toEqual([]);
  });
});

describe("remap math across a region split (integration)", () => {
  it("offsets each split sub-region's segments by ITS OWN start, not the original unsplit region's start", () => {
    // A single long raw region [100, 950] (850s) gets split at 600s into two
    // sub-regions: [100, 700) and [700, 950). Simulate whisper transcribing
    // EACH sub-region independently (segments relative to that sub-region's
    // own start, i.e. beginning at 0).
    const [regionA, regionB] = splitLongRegions([region(100, 950)], 600);
    expect(regionA).toEqual(region(100, 700));
    expect(regionB).toEqual(region(700, 950));

    const wordsInA: TranscriptSegment[] = [{ t0: 0, t1: 2, text: "start of speech" }];
    const wordsInB: TranscriptSegment[] = [{ t0: 0, t1: 3, text: "continues after the cut" }];

    const absoluteA = offsetSegments(wordsInA, regionA.start);
    const absoluteB = offsetSegments(wordsInB, regionB.start);

    // regionA's segment offsets by 100 (its own start).
    expect(absoluteA).toEqual([{ t0: 100, t1: 102, text: "start of speech" }]);
    // regionB's segment offsets by 700 (ITS own start) — NOT by 100, the
    // original unsplit region's start. This is the critical invariant: a
    // naive implementation that remembered only the pre-split region start
    // would incorrectly produce t0: 100 here instead of 700.
    expect(absoluteB).toEqual([{ t0: 700, t1: 703, text: "continues after the cut" }]);
  });

  it("keeps split sub-regions contiguous and ascending end-to-end through processVadRegions", () => {
    const finalRegions = processVadRegions([region(0, 1300)], {
      totalDurationS: 2000,
      maxRegionS: 600,
      padS: 0,
      mergeGapS: 0,
    });
    expect(finalRegions).toEqual([region(0, 600), region(600, 1200), region(1200, 1300)]);

    // Fake per-region whisper output (relative time) and remap to absolute.
    const allSegments: TranscriptSegment[] = [];
    for (const [i, r] of finalRegions.entries()) {
      const relative: TranscriptSegment[] = [{ t0: 0, t1: 1, text: `chunk ${i}` }];
      allSegments.push(...offsetSegments(relative, r.start));
    }

    expect(allSegments).toEqual([
      { t0: 0, t1: 1, text: "chunk 0" },
      { t0: 600, t1: 601, text: "chunk 1" },
      { t0: 1200, t1: 1201, text: "chunk 2" },
    ]);
    // Every segment's t0 falls within its own region's [start, end) — the
    // guarantee that makes downstream consumers (selector, filmstrip) safe
    // to treat segment times as absolute clip time.
    allSegments.forEach((seg, i) => {
      expect(seg.t0).toBeGreaterThanOrEqual(finalRegions[i].start);
      expect(seg.t0).toBeLessThan(finalRegions[i].end);
    });
  });
});

describe("exported defaults", () => {
  it("are all positive", () => {
    expect(VAD_MERGE_GAP_S).toBeGreaterThan(0);
    expect(VAD_PAD_S).toBeGreaterThan(0);
    expect(VAD_MIN_REGION_S).toBeGreaterThan(0);
  });
});
