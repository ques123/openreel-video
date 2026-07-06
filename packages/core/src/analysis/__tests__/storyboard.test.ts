import { describe, expect, it } from "vitest";
import { trimStoryboardToTarget, validateStoryboard } from "../storyboard";
import type { Storyboard } from "../director-types";
import { makeDossier, makeShot } from "./director-fixtures";

// Default fixture: shots #0 0-10s, #1 10-25s, #2 25-60s over a 60s clip.
const dossiers = [
  makeDossier({ clipId: "clip-a", fileName: "a.mp4" }),
  makeDossier({ clipId: "clip-b", fileName: "b.mp4", durationS: 30, shots: [makeShot(0, 0, 30)] }),
];

const submit = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ items, ...extra });

const item = (over: Record<string, unknown> = {}) => ({
  clipId: "clip-a",
  shotIndex: 1,
  in: 11,
  out: 16,
  role: "hook",
  why: "test",
  ...over,
});

describe("validateStoryboard", () => {
  it("accepts a clean submission untouched", () => {
    const v = validateStoryboard(submit([item()], { title: "Cut" }), dossiers);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.storyboard).not.toBeNull();
    const it0 = v.storyboard!.items[0];
    expect(it0).toMatchObject({
      clipId: "clip-a",
      fileName: "a.mp4",
      shotIndex: 1,
      inS: 11,
      outS: 16,
      role: "hook",
    });
    expect(v.storyboard!.title).toBe("Cut");
  });

  it("rejects unparseable JSON", () => {
    const v = validateStoryboard("{nope", dossiers);
    expect(v.storyboard).toBeNull();
    expect(v.errors[0]).toContain("not valid JSON");
  });

  it("rejects a missing/empty items array", () => {
    expect(validateStoryboard("{}", dossiers).storyboard).toBeNull();
    expect(validateStoryboard(submit([]), dossiers).storyboard).toBeNull();
  });

  it("clamps ranges to the anchored shot and records a warning", () => {
    const v = validateStoryboard(submit([item({ in: 5, out: 40 })]), dossiers);
    expect(v.errors).toEqual([]);
    expect(v.storyboard!.items[0]).toMatchObject({ inS: 10, outS: 25 });
    expect(v.warnings[0]).toContain("clamped");
  });

  it("drops unknown clipIds with an error listing known ids", () => {
    const v = validateStoryboard(submit([item({ clipId: "nope" }), item()]), dossiers);
    expect(v.errors[0]).toContain('unknown clipId "nope"');
    expect(v.errors[0]).toContain("clip-a, clip-b");
    expect(v.storyboard!.items).toHaveLength(1);
  });

  it("resolves a fileName used in place of the clipId", () => {
    const v = validateStoryboard(submit([item({ clipId: "b.mp4", shotIndex: 0, in: 0, out: 5 })]), dossiers);
    expect(v.errors).toEqual([]);
    expect(v.storyboard!.items[0].clipId).toBe("clip-b");
  });

  it("rejects segments too short after clamping", () => {
    // Shot #1 is 10-25s; a range entirely past its end clamps to zero length.
    const v = validateStoryboard(submit([item({ in: 26, out: 30 })]), dossiers);
    expect(v.errors[0]).toContain("after clamping");
    expect(v.storyboard).toBeNull();
  });

  it("rejects non-finite in/out", () => {
    const v = validateStoryboard(submit([item({ in: "x" })]), dossiers);
    expect(v.errors[0]).toContain("finite numbers");
  });

  it("never extends past the analyzed prefix of a partial clip", () => {
    const partial = [
      makeDossier({
        clipId: "clip-p",
        durationS: 1620,
        analyzedThroughS: 400,
        shots: [makeShot(0, 0, 400)],
      }),
    ];
    const v = validateStoryboard(
      submit([{ clipId: "clip-p", in: 390, out: 900, role: "b-roll", why: "x" }]),
      partial,
    );
    expect(v.storyboard!.items[0]).toMatchObject({ inS: 390, outS: 400 });
  });

  it("falls back to clip bounds when shotIndex does not exist", () => {
    const v = validateStoryboard(submit([item({ shotIndex: 99, in: 30, out: 35 })]), dossiers);
    expect(v.errors).toEqual([]);
    expect(v.warnings[0]).toContain("shot #99 does not exist");
    expect(v.storyboard!.items[0]).toMatchObject({ shotIndex: null, inS: 30, outS: 35 });
  });

  it("resolves the covering shot's thumbnail when unanchored", () => {
    const v = validateStoryboard(submit([item({ shotIndex: undefined, in: 30, out: 35 })]), dossiers);
    // 30s falls inside shot #2 (25-60s).
    expect(v.storyboard!.items[0].thumbnailDataUrl).toBe("thumb-2");
  });

  it("errors when total duration misses the target by >10%", () => {
    const v = validateStoryboard(submit([item()]), dossiers, { targetDurationS: 60 });
    expect(v.errors[0]).toContain("under the 60.0s target");
  });

  it("warns (not errors) at 5-10% drift", () => {
    // 5s vs 5.4s target = 7.4% off.
    const v = validateStoryboard(submit([item()]), dossiers, { targetDurationS: 5.4 });
    expect(v.errors).toEqual([]);
    expect(v.warnings[0]).toContain("vs target");
  });

  it("reports a structured duration outcome", () => {
    const miss = validateStoryboard(submit([item()]), dossiers, { targetDurationS: 60 });
    expect(miss.duration).toMatchObject({ targetS: 60, totalS: 5, violation: "under" });
    const hit = validateStoryboard(submit([item()]), dossiers, { targetDurationS: 5 });
    expect(hit.duration).toMatchObject({ targetS: 5, totalS: 5, violation: null });
    expect(validateStoryboard(submit([item()]), dossiers).duration).toBeNull();
  });

  it("defaults a missing role", () => {
    const v = validateStoryboard(submit([item({ role: undefined })]), dossiers);
    expect(v.storyboard!.items[0].role).toBe("segment");
  });

  describe("chronology", () => {
    const dated = [
      makeDossier({ clipId: "clip-early", fileName: "early.mp4", recordedAt: 1_000_000 }),
      makeDossier({ clipId: "clip-late", fileName: "late.mp4", recordedAt: 9_000_000 }),
    ];
    const seg = (clipId: string, inS: number) => ({
      clipId,
      in: inS,
      out: inS + 3,
      role: "b-roll",
      why: "x",
    });

    it("warns when a later-recorded clip precedes an earlier one", () => {
      const v = validateStoryboard(
        submit([seg("clip-late", 0), seg("clip-early", 0)]),
        dated,
      );
      expect(v.errors).toEqual([]);
      expect(v.warnings.some((w) => w.includes("jump BACK in time"))).toBe(true);
    });

    it("warns on backward jumps within one clip", () => {
      const v = validateStoryboard(
        submit([seg("clip-early", 20), seg("clip-early", 5)]),
        dated,
      );
      expect(v.warnings.some((w) => w.includes("jump BACK in time"))).toBe(true);
    });

    it("stays quiet for chronological cuts and undated clips", () => {
      const ordered = validateStoryboard(
        submit([seg("clip-early", 0), seg("clip-late", 0)]),
        dated,
      );
      expect(ordered.warnings).toEqual([]);
      const undated = validateStoryboard(
        submit([{ ...seg("clip-a", 30), clipId: "clip-a" }, { ...seg("clip-a", 5) }]),
        dossiers,
      );
      expect(undated.warnings.every((w) => !w.includes("jump BACK"))).toBe(true);
    });
  });

  describe("mid-speech cut snapping", () => {
    // Spoken segment 12-14s inside shot #1 (10-25s).
    const talky = [
      makeDossier({
        clipId: "clip-t",
        fileName: "t.mp4",
        transcript: [{ t0: 12, t1: 14, text: "hello there world" }],
      }),
    ];
    const tItem = (over: Record<string, unknown> = {}) => ({
      clipId: "clip-t",
      shotIndex: 1,
      in: 10.5,
      out: 16,
      role: "hook",
      why: "x",
      ...over,
    });

    it("snaps an out point within 300ms of a segment boundary", () => {
      const v = validateStoryboard(submit([tItem({ out: 13.8 })]), talky);
      expect(v.errors).toEqual([]);
      expect(v.storyboard!.items[0].outS).toBeCloseTo(14);
      expect(v.warnings.some((w) => w.includes("snapped to speech boundary"))).toBe(true);
    });

    it("snaps an in point within 300ms of a segment boundary", () => {
      const v = validateStoryboard(submit([tItem({ in: 12.2 })]), talky);
      expect(v.errors).toEqual([]);
      expect(v.storyboard!.items[0].inS).toBeCloseTo(12);
    });

    it("warns (without moving the cut) when a cut lands deep inside speech", () => {
      const v = validateStoryboard(submit([tItem({ out: 13 })]), talky);
      expect(v.errors).toEqual([]);
      expect(v.storyboard!.items[0].outS).toBe(13);
      expect(v.warnings.some((w) => w.includes('"out" at 13.00s cuts mid-speech'))).toBe(true);
    });

    it("never snaps outside the clamp bounds", () => {
      // Segment straddles the shot start: t0 (9.9s) is outside shot #1,
      // t1 (11.5s) is beyond snap range — warn, don't move.
      const straddle = [
        makeDossier({
          clipId: "clip-s",
          transcript: [{ t0: 9.9, t1: 11.5, text: "spanning the cut" }],
        }),
      ];
      const v = validateStoryboard(
        submit([{ clipId: "clip-s", shotIndex: 1, in: 10.15, out: 16, role: "hook", why: "x" }]),
        straddle,
      );
      expect(v.storyboard!.items[0].inS).toBeCloseTo(10.15);
      expect(v.warnings.some((w) => w.includes("cuts mid-speech"))).toBe(true);
    });

    it("leaves boundary-exact cuts and silence untouched", () => {
      const v = validateStoryboard(submit([tItem({ in: 12, out: 14 })]), talky);
      expect(v.errors).toEqual([]);
      expect(v.warnings).toEqual([]);
      expect(v.storyboard!.items[0]).toMatchObject({ inS: 12, outS: 14 });
    });
  });

  describe("metrics", () => {
    it("computes the mid-speech cut fraction from the FINAL (snapped) cuts", () => {
      const talky = [
        makeDossier({ clipId: "clip-t", transcript: [{ t0: 12, t1: 14, text: "a line" }] }),
      ];
      const seg = (out: number) => [
        { clipId: "clip-t", shotIndex: 1, in: 10.5, out, role: "a", why: "x" },
      ];
      // 13.8 snaps to 14 -> both cuts clean.
      const clean = validateStoryboard(submit(seg(13.8)), talky);
      expect(clean.metrics).toMatchObject({
        cutCount: 2,
        midSpeechCutCount: 0,
        midSpeechCutFraction: 0,
      });
      // 13 stays put -> one of two cuts is mid-speech.
      const dirty = validateStoryboard(submit(seg(13)), talky);
      expect(dirty.metrics).toMatchObject({
        cutCount: 2,
        midSpeechCutCount: 1,
        midSpeechCutFraction: 0.5,
      });
    });

    it("computes adjacent-pair embedding cosines where embeddings exist", () => {
      const e = (x: number, y: number) => Float32Array.from([x, y]);
      const withEmb = [
        makeDossier({
          clipId: "clip-e",
          shots: [
            makeShot(0, 0, 10, { embedding: e(1, 0) }),
            makeShot(1, 10, 25, { embedding: e(0, 1) }),
            makeShot(2, 25, 60, { embedding: e(0, 1) }),
          ],
        }),
      ];
      const v = validateStoryboard(
        submit([
          { clipId: "clip-e", shotIndex: 0, in: 0, out: 5, role: "a", why: "x" },
          { clipId: "clip-e", shotIndex: 1, in: 10, out: 15, role: "b", why: "x" },
          { clipId: "clip-e", shotIndex: 2, in: 25, out: 30, role: "c", why: "x" },
        ]),
        withEmb,
      );
      // Pairs: (0,1) cos 0 and (1,2) cos 1 — mean 0.5, max 1.
      expect(v.metrics!.adjacentPairCount).toBe(2);
      expect(v.metrics!.adjacentCosineMean).toBeCloseTo(0.5);
      expect(v.metrics!.adjacentCosineMax).toBeCloseTo(1);
    });

    it("returns null cosines when embeddings are missing", () => {
      const v = validateStoryboard(
        submit([item(), item({ shotIndex: 2, in: 25, out: 30 })]),
        dossiers,
      );
      expect(v.metrics).toMatchObject({
        adjacentPairCount: 0,
        adjacentCosineMean: null,
        adjacentCosineMax: null,
      });
    });
  });

  describe("trimStoryboardToTarget", () => {
    const board = (durs: number[]): Storyboard => ({
      title: null,
      notes: null,
      items: durs.map((d, i) => ({
        clipId: "c",
        fileName: "c.mp4",
        shotIndex: i,
        inS: 0,
        outS: d,
        role: "r",
        why: "",
        thumbnailDataUrl: null,
      })),
    });

    it("drops tail segments then shortens the last to hit the target", () => {
      const r = trimStoryboardToTarget(board([10, 10, 10]), 12);
      expect(r.storyboard.items).toHaveLength(2);
      expect(r.droppedItems).toBe(1);
      expect(r.shortenedLastByS).toBeCloseTo(8);
      expect(r.finalDurationS).toBeCloseTo(12);
      expect(r.storyboard.items[1].outS).toBeCloseTo(2);
    });

    it("never drops the only segment and respects the minimum item length", () => {
      const r = trimStoryboardToTarget(board([10]), 0.1);
      expect(r.storyboard.items).toHaveLength(1);
      expect(r.finalDurationS).toBeCloseTo(0.3);
    });

    it("leaves an at-target board untouched", () => {
      const r = trimStoryboardToTarget(board([5, 5]), 10);
      expect(r).toMatchObject({ droppedItems: 0, shortenedLastByS: 0, finalDurationS: 10 });
      expect(r.storyboard.items).toHaveLength(2);
    });
  });
});
