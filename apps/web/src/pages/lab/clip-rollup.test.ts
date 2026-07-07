/**
 * Fleet-rollup / clip-list derivations: queued-vs-analyzing status splitting,
 * the header rollup at multi-clip scale, name/status filtering, shift-click
 * range-selection math, and bulk-enhance run summaries. Plain vitest, no
 * DOM — same harness pattern as enhance-cost.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  clipIdRange,
  derivedStatusOf,
  deriveFleetRollup,
  filterClips,
  fmtClipTime,
  formatBulkSummary,
  retryClipIds,
  stageLabelOf,
  summarizeBulkRun,
  type BulkClipResult,
  type RollupClip,
} from "./clip-rollup";

/** RollupClip fixture with sane "just added, nothing happened yet" defaults. */
function mkClip(overrides: Partial<RollupClip> & { clipId: string }): RollupClip {
  return {
    fileName: `${overrides.clipId}.mp4`,
    status: "analyzing",
    durationS: 0,
    analyzedThroughS: null,
    decodeT: 0,
    ingestProgress: null,
    captionsDone: 0,
    captionsTotal: 0,
    ...overrides,
  };
}

describe("derivedStatusOf", () => {
  it("passes done/error/cancelled through unchanged", () => {
    expect(derivedStatusOf(mkClip({ clipId: "a", status: "done" }))).toBe("done");
    expect(derivedStatusOf(mkClip({ clipId: "a", status: "error" }))).toBe("error");
    expect(derivedStatusOf(mkClip({ clipId: "a", status: "cancelled" }))).toBe("cancelled");
  });

  it("an analyzing clip with zero pipeline signal is queued", () => {
    const c = mkClip({
      clipId: "a",
      status: "analyzing",
      ingestProgress: null,
      decodeT: 0,
      durationS: 0,
    });
    expect(derivedStatusOf(c)).toBe("queued");
  });

  it("ingestProgress of exactly 0 still counts as started (0 !== null)", () => {
    const c = mkClip({ clipId: "a", status: "analyzing", ingestProgress: 0 });
    expect(derivedStatusOf(c)).toBe("analyzing");
  });

  it("decodeT > 0 alone counts as started", () => {
    const c = mkClip({ clipId: "a", status: "analyzing", ingestProgress: null, decodeT: 3.2 });
    expect(derivedStatusOf(c)).toBe("analyzing");
  });

  it("durationS > 0 alone (metadata arrived) counts as started", () => {
    const c = mkClip({ clipId: "a", status: "analyzing", ingestProgress: null, durationS: 12 });
    expect(derivedStatusOf(c)).toBe("analyzing");
  });
});

describe("stageLabelOf", () => {
  it("reports ingest percentage while ingestProgress is set", () => {
    const c = mkClip({ clipId: "a", ingestProgress: 0.4 });
    expect(stageLabelOf(c)).toBe("ingesting 40%");
  });

  it("reports scanning percentage against analyzedThroughS once decoding", () => {
    const c = mkClip({ clipId: "a", ingestProgress: null, analyzedThroughS: 10, decodeT: 5 });
    expect(stageLabelOf(c)).toBe("scanning 50%");
  });

  it("falls back to durationS for the span when analyzedThroughS is null", () => {
    const c = mkClip({ clipId: "a", ingestProgress: null, durationS: 20, decodeT: 10 });
    expect(stageLabelOf(c)).toBe("scanning 50%");
  });

  it("reports the rolling-window pass when multi-window ingest is active", () => {
    const c = mkClip({
      clipId: "a",
      ingestProgress: null,
      durationS: 100,
      decodeT: 25,
      ingestWindow: { window: 2, windows: 4, analyzedThroughS: 50 },
    });
    expect(stageLabelOf(c)).toBe("scanning pass 2/4 · 25%");
  });

  it("reports transcribing once the visual span is effectively complete", () => {
    const c = mkClip({ clipId: "a", ingestProgress: null, durationS: 10, decodeT: 9.95 });
    expect(stageLabelOf(c)).toBe("transcribing");
  });
});

describe("deriveFleetRollup", () => {
  it("returns an all-zero rollup for an empty fleet", () => {
    const rollup = deriveFleetRollup([]);
    expect(rollup).toEqual({
      total: 0,
      done: 0,
      error: 0,
      cancelled: 0,
      analyzing: 0,
      queued: 0,
      active: null,
      describing: null,
    });
  });

  it("buckets a mixed fleet (done, error, cancelled, queued, analyzing) correctly", () => {
    const clips: RollupClip[] = [
      mkClip({ clipId: "done-1", status: "done" }),
      mkClip({ clipId: "error-1", status: "error", error: "boom" }),
      mkClip({ clipId: "cancelled-1", status: "cancelled" }),
      mkClip({
        clipId: "queued-1",
        status: "analyzing",
        ingestProgress: null,
        decodeT: 0,
        durationS: 0,
      }),
      mkClip({ clipId: "active-1", status: "analyzing", ingestProgress: 0.4 }),
      mkClip({ clipId: "active-2", status: "analyzing", ingestProgress: null, decodeT: 2 }),
    ];

    const rollup = deriveFleetRollup(clips);

    expect(rollup.total).toBe(6);
    expect(rollup.done).toBe(1);
    expect(rollup.error).toBe(1);
    expect(rollup.cancelled).toBe(1);
    expect(rollup.queued).toBe(1);
    expect(rollup.analyzing).toBe(2);
  });

  it("active is the FIRST actively-analyzing clip in list order, not the last", () => {
    const clips: RollupClip[] = [
      mkClip({ clipId: "queued-1", ingestProgress: null, decodeT: 0, durationS: 0 }),
      mkClip({ clipId: "active-1", ingestProgress: 0.25 }),
      mkClip({ clipId: "active-2", ingestProgress: 0.9 }),
    ];
    const rollup = deriveFleetRollup(clips);
    expect(rollup.active).toEqual({
      clipId: "active-1",
      fileName: "active-1.mp4",
      stage: "ingesting 25%",
    });
  });

  it("active stays null when nothing is actively analyzing (only queued/done/error)", () => {
    const clips: RollupClip[] = [
      mkClip({ clipId: "done-1", status: "done" }),
      mkClip({ clipId: "queued-1", ingestProgress: null, decodeT: 0, durationS: 0 }),
    ];
    const rollup = deriveFleetRollup(clips);
    expect(rollup.active).toBeNull();
    expect(rollup.queued).toBe(1);
    expect(rollup.analyzing).toBe(0);
  });

  it("describing sums only clips still short of their caption total, excluding fully-captioned ones", () => {
    const clips: RollupClip[] = [
      mkClip({ clipId: "still-describing", status: "done", captionsDone: 2, captionsTotal: 5 }),
      mkClip({ clipId: "fully-captioned", status: "done", captionsDone: 3, captionsTotal: 3 }),
      mkClip({ clipId: "also-describing", status: "done", captionsDone: 1, captionsTotal: 4 }),
    ];
    const rollup = deriveFleetRollup(clips);
    // Only the two still-in-progress clips contribute: 2+1 done of 5+4 total.
    expect(rollup.describing).toEqual({ done: 3, total: 9 });
  });

  it("describing is null when no clip has a nonzero caption total", () => {
    const clips: RollupClip[] = [mkClip({ clipId: "a", status: "done" })];
    expect(deriveFleetRollup(clips).describing).toBeNull();
  });
});

describe("filterClips", () => {
  const clips: RollupClip[] = [
    mkClip({ clipId: "1", fileName: "IMG_0001.MOV", status: "done" }),
    mkClip({ clipId: "2", fileName: "IMG_0002.MOV", status: "error" }),
    mkClip({ clipId: "3", fileName: "beach-sunset.mp4", status: "cancelled" }),
    mkClip({
      clipId: "4",
      fileName: "beach-drone.mp4",
      status: "analyzing",
      ingestProgress: null,
      decodeT: 0,
      durationS: 0,
    }),
    mkClip({ clipId: "5", fileName: "beach-family.mp4", status: "analyzing", ingestProgress: 0.5 }),
  ];

  it("returns the SAME array reference when no filter is active (no-op fast path)", () => {
    expect(filterClips(clips, "", "all")).toBe(clips);
    expect(filterClips(clips, "   ", "all")).toBe(clips);
  });

  it("filters by case-insensitive name substring", () => {
    const result = filterClips(clips, "BEACH", "all");
    expect(result.map((c) => c.clipId)).toEqual(["3", "4", "5"]);
  });

  it("filters by derived status, splitting queued from analyzing", () => {
    expect(filterClips(clips, "", "queued").map((c) => c.clipId)).toEqual(["4"]);
    expect(filterClips(clips, "", "analyzing").map((c) => c.clipId)).toEqual(["5"]);
    expect(filterClips(clips, "", "done").map((c) => c.clipId)).toEqual(["1"]);
    expect(filterClips(clips, "", "error").map((c) => c.clipId)).toEqual(["2"]);
    expect(filterClips(clips, "", "cancelled").map((c) => c.clipId)).toEqual(["3"]);
  });

  it("combines name and status filters (both must match)", () => {
    expect(filterClips(clips, "beach", "cancelled").map((c) => c.clipId)).toEqual(["3"]);
    expect(filterClips(clips, "beach", "done")).toEqual([]);
  });

  it("preserves original order", () => {
    const result = filterClips(clips, "", "all");
    expect(result.map((c) => c.clipId)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterClips(clips, "nonexistent-name", "all")).toEqual([]);
  });
});

describe("clipIdRange", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("selects the inclusive forward range (anchor before target)", () => {
    expect(clipIdRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("selects the inclusive range in LIST order even when clicked backward", () => {
    // Anchor "d" clicked first, then shift-click back up to "b" — the range
    // is the same set of rows regardless of click direction.
    expect(clipIdRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("returns just the target when anchor equals target", () => {
    expect(clipIdRange(ids, "c", "c")).toEqual(["c"]);
  });

  it("degrades to just the target when the target id is unknown", () => {
    expect(clipIdRange(ids, "a", "not-in-list")).toEqual(["not-in-list"]);
  });

  it("degrades to just the target when there is no anchor yet (null)", () => {
    expect(clipIdRange(ids, null, "c")).toEqual(["c"]);
  });

  it("degrades to just the target when the anchor has vanished (filtered out)", () => {
    expect(clipIdRange(ids, "vanished-anchor", "c")).toEqual(["c"]);
  });

  it("covers the full range end to end", () => {
    expect(clipIdRange(ids, "a", "e")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("summarizeBulkRun / retryClipIds / formatBulkSummary", () => {
  it("summarizes an all-success run", () => {
    const results: BulkClipResult[] = [
      { clipId: "1", fileName: "a.mp4", ok: true },
      { clipId: "2", fileName: "b.mp4", ok: true },
    ];
    const summary = summarizeBulkRun(results, 45_000);
    expect(summary).toEqual({ total: 2, succeeded: 2, failed: [], wallMs: 45_000 });
    expect(formatBulkSummary(summary)).toBe("2/2 enhanced · 45s");
    expect(retryClipIds(summary)).toEqual([]);
  });

  it("summarizes a mixed run and carries failure detail", () => {
    const results: BulkClipResult[] = [
      { clipId: "1", fileName: "a.mp4", ok: true },
      { clipId: "2", fileName: "b.mp4", ok: false, error: "rate limited" },
      { clipId: "3", fileName: "c.mp4", ok: false, error: "network error" },
    ];
    const summary = summarizeBulkRun(results, 832_000);
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toEqual([
      { clipId: "2", fileName: "b.mp4", ok: false, error: "rate limited" },
      { clipId: "3", fileName: "c.mp4", ok: false, error: "network error" },
    ]);
    expect(summary.wallMs).toBe(832_000);
    expect(formatBulkSummary(summary)).toBe("1/3 enhanced, 2 failed · 13m52s");
    expect(retryClipIds(summary)).toEqual(["2", "3"]);
  });

  it("de-dupes retryClipIds while keeping first-seen order", () => {
    const summary = summarizeBulkRun(
      [
        { clipId: "1", fileName: "a.mp4", ok: false, error: "x" },
        { clipId: "2", fileName: "b.mp4", ok: false, error: "y" },
        { clipId: "1", fileName: "a.mp4", ok: false, error: "x again" },
      ],
      0,
    );
    expect(retryClipIds(summary)).toEqual(["1", "2"]);
  });

  it("formats a zero-clip run without a failure clause OR a duration clause", () => {
    expect(formatBulkSummary(summarizeBulkRun([], 0))).toBe("0/0 enhanced");
    // Even a nonzero wallMs (e.g. guardrail-confirm time) stays hidden — there
    // were no clips to time.
    expect(formatBulkSummary(summarizeBulkRun([], 5_000))).toBe("0/0 enhanced");
  });

  it("formats sub-minute durations as seconds only, minute-plus as Xm YYs", () => {
    const oneClip: BulkClipResult[] = [{ clipId: "1", fileName: "a.mp4", ok: true }];
    expect(formatBulkSummary(summarizeBulkRun(oneClip, 9_000))).toBe("1/1 enhanced · 9s");
    expect(formatBulkSummary(summarizeBulkRun(oneClip, 60_000))).toBe("1/1 enhanced · 1m00s");
    expect(formatBulkSummary(summarizeBulkRun(oneClip, 832_000))).toBe("1/1 enhanced · 13m52s");
  });
});

describe("fmtClipTime", () => {
  it("formats sub-minute durations", () => {
    expect(fmtClipTime(5.4)).toBe("0:05.4");
  });

  it("formats minutes and seconds with one decimal, zero-padded", () => {
    expect(fmtClipTime(83.4)).toBe("1:23.4");
  });
});
