import { describe, expect, it } from "vitest";
import { BLUR_SHARPNESS_THRESHOLD } from "../cloud-vision-plan";
import { planLocalCaptionFrames } from "../funnel-orchestrator";
import type { DenseCaption, DenseFrame } from "../types";

// planLocalCaptionFrames is the pure planning half of the local caption
// pass (resume filter + blur gate); the worker round-trip around it needs a
// browser and is exercised in the lab, not here.

function frame(t: number, sharpness?: number): DenseFrame {
  return { t, dataUrl: `data:image/jpeg;base64,f${t}`, sharpness };
}

describe("planLocalCaptionFrames", () => {
  it("returns every frame, in order, when nothing is captioned yet", () => {
    const frames = [frame(0, 300), frame(2, 250), frame(4, 400)];
    const plan = planLocalCaptionFrames(frames, []);
    expect(plan.map((p) => p.frame.t)).toEqual([0, 2, 4]);
    expect(plan.every((p) => !p.blurry)).toBe(true);
  });

  it("resumes after the last captioned timestamp (earlier frames are done)", () => {
    const frames = [frame(0, 300), frame(2, 300), frame(4, 300), frame(6, 300)];
    const captions: DenseCaption[] = [
      { t: 0, text: "a market" },
      { t: 2, text: "a market stall" },
    ];
    const plan = planLocalCaptionFrames(frames, captions);
    expect(plan.map((p) => p.frame.t)).toEqual([4, 6]);
  });

  it("flags frames below the cloud pass's blur threshold and keeps the rest", () => {
    const frames = [
      frame(0, BLUR_SHARPNESS_THRESHOLD - 1), // blurry
      frame(2, BLUR_SHARPNESS_THRESHOLD), // exactly at threshold = sharp (same gate as cloud)
      frame(4, 900),
    ];
    const plan = planLocalCaptionFrames(frames, []);
    expect(plan.map((p) => p.blurry)).toEqual([true, false, false]);
  });

  it("treats legacy frames without a sharpness field as sharp (caption them)", () => {
    const plan = planLocalCaptionFrames([frame(0), frame(2, 10)], []);
    expect(plan.map((p) => p.blurry)).toEqual([false, true]);
  });

  it("returns [] when the pass already completed", () => {
    const frames = [frame(0, 300), frame(2, 300)];
    const captions: DenseCaption[] = [
      { t: 0, text: "a" },
      { t: 2, text: "b" },
    ];
    expect(planLocalCaptionFrames(frames, captions)).toEqual([]);
  });
});
