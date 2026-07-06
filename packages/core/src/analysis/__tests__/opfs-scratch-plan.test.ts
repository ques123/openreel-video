import { describe, expect, it } from "vitest";
import {
  MIN_WINDOW_BYTES,
  QUOTA_SAFETY_BYTES,
  SAFE_BLOB_READ_MAX_BYTES,
  WINDOW_HEAD_BYTES,
  WINDOW_OVERLAP_BYTES,
  WINDOW_TAIL_BYTES,
  mapWindowRead,
  planAudioBackfillRoute,
  planIngestWindows,
} from "../workers/opfs-scratch";
import type { WindowScratchMeta } from "../workers/opfs-scratch";

// planIngestWindows, mapWindowRead and planAudioBackfillRoute are the only
// pure pieces of opfs-scratch.ts — everything else touches OPFS
// (FileSystemSyncAccessHandle et al.), which doesn't exist in vitest's node
// environment. Those are exercised manually / by the funnel integration,
// not here.

type Window = { startByte: number; endByte: number };

/** [0, totalSize) has no gaps across the ordered window list. */
function assertFullCoverage(windows: Window[], totalSize: number): void {
  expect(windows.length).toBeGreaterThan(0);
  expect(windows[0].startByte).toBe(0);
  let coveredTo = 0;
  for (const w of windows) {
    expect(w.startByte).toBeLessThanOrEqual(coveredTo);
    coveredTo = Math.max(coveredTo, w.endByte);
  }
  expect(coveredTo).toBe(totalSize);
}

/**
 * windows[i+1].startByte == windows[i].endByte - WINDOW_OVERLAP_BYTES
 * (clamped >= 0), and endByte is strictly increasing (forward progress).
 */
function assertOverlapChain(windows: Window[]): void {
  for (let i = 1; i < windows.length; i += 1) {
    const expectedStart = Math.max(0, windows[i - 1].endByte - WINDOW_OVERLAP_BYTES);
    expect(windows[i].startByte).toBe(expectedStart);
    expect(windows[i].endByte).toBeGreaterThan(windows[i - 1].endByte);
  }
}

describe("planIngestWindows", () => {
  it("returns a single window when the file comfortably fits the budget", () => {
    const plan = planIngestWindows(1_000, 2_000);
    expect(plan).toEqual({
      windows: [{ startByte: 0, endByte: 1_000 }],
      headBytes: 0,
      tailBytes: 0,
    });
  });

  it("returns a single window at the exact totalSize == budgetBytes boundary", () => {
    const totalSize = 5_000_000_000;
    const plan = planIngestWindows(totalSize, totalSize);
    expect(plan).toEqual({
      windows: [{ startByte: 0, endByte: totalSize }],
      headBytes: 0,
      tailBytes: 0,
    });
  });

  it("plans multiple overlapping windows when the file exceeds the budget", () => {
    const totalSize = 10 * 2 ** 30; // 10GiB
    const budgetBytes = 3 * 2 ** 30; // 3GiB
    const plan = planIngestWindows(totalSize, budgetBytes);
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.headBytes).toBe(WINDOW_HEAD_BYTES);
    expect(plan.tailBytes).toBe(WINDOW_TAIL_BYTES);
    expect(plan.windows.length).toBe(4);
    expect(plan.windows[plan.windows.length - 1].endByte).toBe(totalSize);
    assertOverlapChain(plan.windows);
    assertFullCoverage(plan.windows, totalSize);
  });

  it("returns null when the budget can't fit a useful window (capacity < MIN_WINDOW_BYTES)", () => {
    // totalSize large enough that head+tail both saturate at their max.
    const totalSize = 45_000_000_000;
    const budgetBytes = 500_000_000; // capacity ~349MB, well under MIN_WINDOW_BYTES (1GB)
    expect(planIngestWindows(totalSize, budgetBytes)).toBeNull();
  });

  it("guards the exact capacity threshold: null just below it, a plan at it", () => {
    // Compute the threshold from the exported constants so this test stays
    // correct even if the constants change (currently MIN_WINDOW_BYTES
    // dominates 2x WINDOW_OVERLAP_BYTES, but don't assume that).
    const totalSize = 1e12; // comfortably bigger than any budget used below
    const threshold = Math.max(MIN_WINDOW_BYTES, 2 * WINDOW_OVERLAP_BYTES);
    const overhead = WINDOW_HEAD_BYTES + WINDOW_TAIL_BYTES;

    const belowPlan = planIngestWindows(totalSize, overhead + threshold - 1);
    expect(belowPlan).toBeNull();

    const atPlan = planIngestWindows(totalSize, overhead + threshold);
    expect(atPlan).not.toBeNull();
    if (!atPlan) return;
    expect(atPlan.windows[0]).toEqual({ startByte: 0, endByte: threshold });
    assertOverlapChain(atPlan.windows);
    assertFullCoverage(atPlan.windows, totalSize);
  });

  it("plans a realistic 45GB file under a 16GB budget in ~3-4 windows with full coverage", () => {
    const totalSize = 45e9;
    const budgetBytes = 16e9;
    const plan = planIngestWindows(totalSize, budgetBytes);
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.windows.length).toBeGreaterThanOrEqual(3);
    expect(plan.windows.length).toBeLessThanOrEqual(4);
    expect(plan.headBytes).toBe(WINDOW_HEAD_BYTES);
    expect(plan.tailBytes).toBe(WINDOW_TAIL_BYTES);
    assertOverlapChain(plan.windows);
    assertFullCoverage(plan.windows, totalSize);
  });

  // Debug geometry overrides: the test hook scales head/tail/overlap/min down
  // so small fixtures exercise the REAL multi-window code path in a browser.
  it("honors geometry overrides for tiny debug fixtures (30MB file, 8MB budget)", () => {
    const totalSize = 30e6;
    const budgetBytes = 8e6;
    const opts = {
      headBytes: 1e6,
      tailBytes: 1e6,
      overlapBytes: 1e6,
      minWindowBytes: 2e6,
    };
    const plan = planIngestWindows(totalSize, budgetBytes, opts);
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.headBytes).toBe(1e6);
    expect(plan.tailBytes).toBe(1e6);
    expect(plan.windows.length).toBeGreaterThanOrEqual(5);
    expect(plan.windows.length).toBeLessThanOrEqual(7);
    // Overlap chain under the OVERRIDDEN overlap value.
    for (let i = 1; i < plan.windows.length; i += 1) {
      expect(plan.windows[i].startByte).toBe(
        Math.max(0, plan.windows[i - 1].endByte - 1e6),
      );
      expect(plan.windows[i].endByte).toBeGreaterThan(plan.windows[i - 1].endByte);
    }
    assertFullCoverage(plan.windows, totalSize);
  });

  it("returns null under overrides when capacity can't clear the overridden minimum", () => {
    expect(
      planIngestWindows(30e6, 3e6, {
        headBytes: 1e6,
        tailBytes: 1e6,
        overlapBytes: 1e6,
        minWindowBytes: 2e6,
      }),
    ).toBeNull();
  });

  it("omitted overrides behave identically to the constant-based plan", () => {
    const totalSize = 45e9;
    const budgetBytes = 16e9;
    expect(planIngestWindows(totalSize, budgetBytes, {})).toEqual(
      planIngestWindows(totalSize, budgetBytes),
    );
  });
});

describe("mapWindowRead", () => {
  const baseMeta: WindowScratchMeta = {
    totalSize: 1_000_000,
    headBytes: 100,
    windowStart: 1_000,
    windowBytes: 2_000, // window = [1000, 3000)
    tailStart: 999_900, // tail = [999900, 1000000) — far from window, no overlap
  };

  it("resolves a read fully inside the window to a single segment", () => {
    const result = mapWindowRead(baseMeta, 1_500, 1_800);
    expect(result).toEqual([{ file: "window", srcOffset: 500, dstOffset: 0, len: 300 }]);
  });

  it("splits a read spanning a CONTIGUOUS head->window boundary (windowStart == headBytes)", () => {
    const meta: WindowScratchMeta = { ...baseMeta, headBytes: 100, windowStart: 100 };
    const result = mapWindowRead(meta, 90, 110);
    expect(result).toEqual([
      { file: "head", srcOffset: 90, dstOffset: 0, len: 10 },
      { file: "window", srcOffset: 0, dstOffset: 10, len: 10 },
    ]);
  });

  it("returns null for a read spanning a GAP between head and window (windowStart > headBytes)", () => {
    const meta: WindowScratchMeta = { ...baseMeta, headBytes: 100, windowStart: 200 };
    const result = mapWindowRead(meta, 90, 210);
    expect(result).toBeNull();
  });

  it("resolves a read fully inside the tail to a single segment", () => {
    const meta: WindowScratchMeta = { ...baseMeta, tailStart: 999_000 };
    const result = mapWindowRead(meta, 999_500, 999_600);
    expect(result).toEqual([{ file: "tail", srcOffset: 500, dstOffset: 0, len: 100 }]);
  });

  it("splits a read spanning the window-end -> tail boundary for the LAST window layout", () => {
    // windowStart + windowBytes === tailStart: the trailing-window case.
    const meta: WindowScratchMeta = {
      totalSize: 1_000_000,
      headBytes: 100,
      windowStart: 500_000,
      windowBytes: 499_000, // window = [500000, 999000)
      tailStart: 999_000, // tail = [999000, 1000000)
    };
    const result = mapWindowRead(meta, 998_990, 999_010);
    expect(result).toEqual([
      { file: "window", srcOffset: 498_990, dstOffset: 0, len: 10 },
      { file: "tail", srcOffset: 0, dstOffset: 10, len: 10 },
    ]);
  });

  it("gives the window precedence over head when the first window fully covers head's range", () => {
    const meta: WindowScratchMeta = {
      ...baseMeta,
      headBytes: 100,
      windowStart: 0,
      windowBytes: 2_000, // window = [0, 2000) ⊇ head's [0, 100)
    };
    const result = mapWindowRead(meta, 0, 50);
    // Entirely serviced by "window", even though "head" also covers [0, 50).
    expect(result).toEqual([{ file: "window", srcOffset: 0, dstOffset: 0, len: 50 }]);
  });

  it("falls back to head for the remainder when window only PARTIALLY covers head's range", () => {
    const meta: WindowScratchMeta = {
      ...baseMeta,
      headBytes: 100,
      windowStart: 0,
      windowBytes: 50, // window = [0, 50) — smaller than head's [0, 100)
    };
    const result = mapWindowRead(meta, 0, 80);
    expect(result).toEqual([
      { file: "window", srcOffset: 0, dstOffset: 0, len: 50 },
      { file: "head", srcOffset: 50, dstOffset: 50, len: 30 },
    ]);
  });

  it("returns [] for an empty range without treating it as an uncovered gap", () => {
    expect(mapWindowRead(baseMeta, 500, 500)).toEqual([]);
  });
});

describe("planAudioBackfillRoute", () => {
  it("routes small files through direct blob reads (up to and including the ceiling)", () => {
    expect(planAudioBackfillRoute(10e6, 0)).toBe("blob");
    expect(planAudioBackfillRoute(SAFE_BLOB_READ_MAX_BYTES, null)).toBe("blob");
  });

  it("routes an over-ceiling file to a scratch copy when quota fits it plus safety", () => {
    const size = SAFE_BLOB_READ_MAX_BYTES + 1;
    expect(planAudioBackfillRoute(size, size + QUOTA_SAFETY_BYTES)).toBe("scratch-copy");
    // The 17GB crash case, with room to spare: copy, never raw blob reads.
    expect(planAudioBackfillRoute(17e9, 30e9)).toBe("scratch-copy");
  });

  it("skips when quota can't hold the file plus the safety margin", () => {
    const size = SAFE_BLOB_READ_MAX_BYTES + 1;
    expect(planAudioBackfillRoute(size, size + QUOTA_SAFETY_BYTES - 1)).toBe("skip");
    // The exact 17GB scenario that used to crash Chrome via raw BlobSource.
    expect(planAudioBackfillRoute(17e9, 10e9)).toBe("skip");
  });

  it("skips large files when quota is unknown — never risks raw blob reads", () => {
    expect(planAudioBackfillRoute(17e9, null)).toBe("skip");
  });
});
