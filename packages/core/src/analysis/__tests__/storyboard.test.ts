import { describe, expect, it } from "vitest";
import { validateStoryboard } from "../storyboard";
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
});
