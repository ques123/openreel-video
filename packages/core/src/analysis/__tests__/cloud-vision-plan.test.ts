import { describe, expect, it } from "vitest";
import {
  applyCloudResults,
  BLUR_SHARPNESS_THRESHOLD,
  BLURRY_FRAME_CAPTION,
  blurryAnnotations,
  expandSpanCaptions,
  MAX_CLOUD_FRAMES,
  planCloudFrames,
  selectCloudFrames,
} from "../cloud-vision-plan";
import { makeDossier, makeShot } from "./director-fixtures";

const frames = [
  { t: 1, dataUrl: "f1" },
  { t: 5, dataUrl: "f5" },
  { t: 9, dataUrl: "f9" },
  { t: 12, dataUrl: "f12" },
  { t: 30, dataUrl: "f30" },
];

describe("selectCloudFrames", () => {
  it("timeline scope sends every dense frame", () => {
    const dossier = makeDossier({ denseFrames: frames });
    expect(selectCloudFrames(dossier, "timeline")).toEqual(frames);
  });

  it("shots scope picks the dense frame nearest each shot's rep time", () => {
    // Shots 0-10 (rep 5), 10-25 (rep 17.5), 25-60 (rep 42.5) from the fixture.
    const dossier = makeDossier({ denseFrames: frames });
    const picked = selectCloudFrames(dossier, "shots");
    expect(picked.map((f) => f.t)).toEqual([5, 12, 30]);
  });

  it("shots scope falls back to the shot thumbnail when no dense frame is near", () => {
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 10, { thumbnailDataUrl: "thumb-0" })],
      denseFrames: [{ t: 50, dataUrl: "far-away" }],
    });
    const picked = selectCloudFrames(dossier, "shots");
    expect(picked).toEqual([{ t: 5, dataUrl: "thumb-0" }]);
  });

  it("dedupes when neighboring shots share a nearest frame", () => {
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 4), makeShot(1, 4, 8)],
      denseFrames: [{ t: 4, dataUrl: "shared" }],
    });
    expect(selectCloudFrames(dossier, "shots")).toHaveLength(1);
  });
});

describe("planCloudFrames", () => {
  const cap = (t: number, text: string) => ({ t, text });

  it("shots scope is untouched: no merge, no blur gate", () => {
    const dossier = makeDossier({
      denseFrames: frames.map((f) => ({ ...f, sharpness: 5 })),
    });
    const plan = planCloudFrames(dossier, "shots");
    expect(plan.frames.map((f) => f.t)).toEqual([5, 12, 30]);
    expect(plan.blurrySkipped).toEqual([]);
  });

  it("merges consecutive frames with near-identical local captions into a span", () => {
    const dossier = makeDossier({
      denseFrames: frames,
      denseCaptions: [
        cap(1, "road with trees and blue sky"),
        cap(5, "road with trees and blue sky ahead"),
        cap(9, "road with trees and sky"),
        cap(12, "a market stall piled with durians"),
        cap(30, "vendor weighing durians at a market stall"),
      ],
    });
    const plan = planCloudFrames(dossier, "timeline");
    // 1-9s collapse to one rep spanning the run; 12s and 30s captions differ.
    expect(plan.frames.map((f) => ({ t: f.t, t1: f.t1 }))).toEqual([
      { t: 1, t1: 9 },
      { t: 12, t1: undefined },
      { t: 30, t1: undefined },
    ]);
    expect(plan.frames[0].dataUrl).toBe("f1");
  });

  it("never merges frames the local caption pass has not reached", () => {
    const dossier = makeDossier({
      denseFrames: frames,
      denseCaptions: [cap(1, "road and trees"), cap(5, "road and trees")],
    });
    const plan = planCloudFrames(dossier, "timeline");
    // 1+5 merge (both captioned, similar); 9/12/30 uncaptioned -> sent as-is.
    expect(plan.frames.map((f) => f.t)).toEqual([1, 9, 12, 30]);
    expect(plan.frames[0].t1).toBe(5);
  });

  it("blur-gates timeline frames and merges across the gap they leave", () => {
    const dossier = makeDossier({
      denseFrames: [
        { t: 1, dataUrl: "f1", sharpness: 400 },
        { t: 5, dataUrl: "f5", sharpness: BLUR_SHARPNESS_THRESHOLD - 1 },
        { t: 9, dataUrl: "f9", sharpness: 400 },
      ],
      denseCaptions: [cap(1, "temple gate in sunlight"), cap(9, "temple gate in the sunlight")],
    });
    const plan = planCloudFrames(dossier, "timeline");
    expect(plan.blurrySkipped.map((f) => f.t)).toEqual([5]);
    // The blurry middle frame doesn't break the static run around it.
    expect(plan.frames).toHaveLength(1);
    expect(plan.frames[0]).toMatchObject({ t: 1, t1: 9 });
  });

  it("anchors similarity to the run's first caption so slow drift breaks the run", () => {
    // Each caption is pairwise-similar to its neighbor (one word swapped)
    // but the third has drifted below the threshold vs the FIRST — which is
    // the frame actually sent. It must start a new run.
    const dossier = makeDossier({
      denseFrames: [
        { t: 0, dataUrl: "f0" },
        { t: 4, dataUrl: "f4" },
        { t: 8, dataUrl: "f8" },
      ],
      denseCaptions: [
        cap(0, "temple gate monk orange robe incense smoke courtyard morning light"),
        cap(4, "gate monk orange robe incense smoke courtyard morning light tourists"),
        cap(8, "monk orange robe incense smoke courtyard morning light tourists vendors"),
      ],
    });
    const plan = planCloudFrames(dossier, "timeline");
    expect(plan.frames.map((f) => ({ t: f.t, t1: f.t1 }))).toEqual([
      { t: 0, t1: 4 },
      { t: 8, t1: undefined },
    ]);
  });

  it("keeps frames without sharpness (pre-field dossiers) and respects the cap", () => {
    const many = Array.from({ length: MAX_CLOUD_FRAMES + 50 }, (_, i) => ({
      t: i,
      dataUrl: `f${i}`,
    }));
    const plan = planCloudFrames(makeDossier({ denseFrames: many }), "timeline");
    expect(plan.blurrySkipped).toEqual([]);
    expect(plan.frames).toHaveLength(MAX_CLOUD_FRAMES);
    // preMergeCount is the pre-cap in-scope count (nothing merged here).
    expect(plan.preMergeCount).toBe(MAX_CLOUD_FRAMES + 50);
  });
});

describe("planCloudFrames preMergeCount (merge-lever instrumentation)", () => {
  const cap = (t: number, text: string) => ({ t, text });

  it("timeline scope: counts in-scope frames before the blur gate and merge", () => {
    const dossier = makeDossier({
      denseFrames: frames,
      denseCaptions: [
        cap(1, "road with trees and blue sky"),
        cap(5, "road with trees and blue sky ahead"),
        cap(9, "road with trees and sky"),
        cap(12, "a market stall piled with durians"),
        cap(30, "vendor weighing durians at a market stall"),
      ],
    });
    const plan = planCloudFrames(dossier, "timeline");
    // 5 in scope; 1-9s merged into one rep -> 3 sent. Savings = 5 - 3.
    expect(plan.preMergeCount).toBe(5);
    expect(plan.frames).toHaveLength(3);
  });

  it("counts blur-gated frames too — the gate is part of the lever being measured", () => {
    const dossier = makeDossier({
      denseFrames: [
        { t: 1, dataUrl: "f1", sharpness: 400 },
        { t: 5, dataUrl: "f5", sharpness: BLUR_SHARPNESS_THRESHOLD - 1 },
        { t: 9, dataUrl: "f9", sharpness: 400 },
      ],
      denseCaptions: [cap(1, "temple gate in sunlight"), cap(9, "temple gate in the sunlight")],
    });
    const plan = planCloudFrames(dossier, "timeline");
    expect(plan.preMergeCount).toBe(3);
    expect(plan.frames).toHaveLength(1);
  });

  it("candidate filtering happens BEFORE the count — out-of-range frames are not lever savings", () => {
    // Shot 0 spans 0-10; frames at 12 and 30 are out of scope, not merged away.
    const dossier = makeDossier({ denseFrames: frames });
    const plan = planCloudFrames(dossier, "timeline", {
      candidateShotIndexes: new Set([0]),
    });
    expect(plan.preMergeCount).toBe(3);
    expect(plan.outOfCandidateRanges).toBe(2);
    expect(plan.frames.map((f) => f.t)).toEqual([1, 5, 9]);
  });

  it("shots scope has no gate or merge: preMergeCount equals frames sent", () => {
    const dossier = makeDossier({ denseFrames: frames });
    const plan = planCloudFrames(dossier, "shots");
    expect(plan.preMergeCount).toBe(plan.frames.length);
    expect(plan.preMergeCount).toBe(3);
  });
});

describe("expandSpanCaptions / blurryAnnotations", () => {
  it("duplicates a span rep's caption at the span end so the merge renders the range", () => {
    const out = expandSpanCaptions(
      [
        { t: 1, text: "long static road" },
        { t: 12, text: "market" },
      ],
      [
        { t: 1, dataUrl: "f1", t1: 9 },
        { t: 12, dataUrl: "f12" },
      ],
    );
    expect(out).toEqual([
      { t: 1, text: "long static road" },
      { t: 9, text: "long static road" },
      { t: 12, text: "market" },
    ]);
  });

  it("annotates blur-gated frames with the unusable marker", () => {
    expect(blurryAnnotations([{ t: 5, dataUrl: "f5", sharpness: 3 }])).toEqual([
      { t: 5, text: BLURRY_FRAME_CAPTION },
    ]);
  });
});

describe("applyCloudResults", () => {
  const meta = { model: "gpt-5.2", enhancedAt: 111, framesSent: 2, framesFailed: 0, ms: 1500, promptTokens: 900, completionTokens: 120 };

  it("timeline scope fills cloudDenseCaptions sorted and stamps provenance", () => {
    const dossier = makeDossier({ denseFrames: frames });
    applyCloudResults(
      dossier,
      "timeline",
      [
        { t: 9, text: "later" },
        { t: 1, text: "earlier" },
      ],
      meta,
    );
    expect(dossier.cloudDenseCaptions.map((c) => c.t)).toEqual([1, 9]);
    expect(dossier.cloudVision).toEqual({ model: "gpt-5.2", enhancedAt: 111, scope: "timeline" });
    expect(dossier.cloudRuns.timeline).toEqual(meta);
    expect(dossier.cloudRuns.shots).toBeNull();
  });

  it("gives each shot the cloud caption nearest its rep frame", () => {
    const dossier = makeDossier();
    applyCloudResults(
      dossier,
      "shots",
      [
        { t: 5, text: "market vendor with durians" },
        { t: 17, text: "walking in the rain" },
      ],
      meta,
    );
    expect(dossier.shots[0].cloudCaption).toBe("market vendor with durians");
    expect(dossier.shots[1].cloudCaption).toBe("walking in the rain");
    // No caption landed near shot 2 (25-60s).
    expect(dossier.shots[2].cloudCaption).toBeNull();
    // shots scope must NOT fabricate a cloud timeline.
    expect(dossier.cloudDenseCaptions).toEqual([]);
  });
});

describe("cloudRunArchive", () => {
  const metaFor = (model: string) => ({
    model,
    enhancedAt: 111,
    framesSent: 2,
    framesFailed: 0,
    ms: 1500,
    promptTokens: 900,
    completionTokens: 120,
  });

  it("keeps runs from different models and replaces same (scope, model)", () => {
    const dossier = makeDossier({ denseFrames: frames });
    applyCloudResults(dossier, "timeline", [{ t: 1, text: "from 5.2" }], metaFor("gpt-5.2"));
    applyCloudResults(dossier, "timeline", [{ t: 1, text: "from mini" }], metaFor("gpt-5.4-mini"));
    applyCloudResults(dossier, "shots", [{ t: 5, text: "shot desc" }], metaFor("gpt-5.2"));
    expect(dossier.cloudRunArchive).toHaveLength(3);
    // Active store reflects the LATEST timeline run.
    expect(dossier.cloudDenseCaptions[0].text).toBe("from mini");
    // Rerun 5.2 timeline: replaces its archive entry, mini survives.
    applyCloudResults(dossier, "timeline", [{ t: 1, text: "from 5.2 v2" }], metaFor("gpt-5.2"));
    expect(dossier.cloudRunArchive).toHaveLength(3);
    const models = dossier.cloudRunArchive.filter((e) => e.scope === "timeline").map((e) => e.model);
    expect(models.sort()).toEqual(["gpt-5.2", "gpt-5.4-mini"]);
    expect(
      dossier.cloudRunArchive.find((e) => e.scope === "timeline" && e.model === "gpt-5.2")!.captions[0].text,
    ).toBe("from 5.2 v2");
  });
});

describe("planCloudFrames candidateShotIndexes", () => {
  const cap = (t: number, text: string) => ({ t, text });

  it("shots scope: filters to only the candidate shots' rep frames", () => {
    // Shots 0-10 (rep 5), 10-25 (rep 17.5), 25-60 (rep 42.5).
    const dossier = makeDossier({ denseFrames: frames });
    const full = planCloudFrames(dossier, "shots");
    expect(full.frames.map((f) => f.t)).toEqual([5, 12, 30]);

    const filtered = planCloudFrames(dossier, "shots", {
      candidateShotIndexes: new Set([0, 2]),
    });
    expect(filtered.frames.map((f) => f.t)).toEqual([5, 30]);
    expect(filtered.blurrySkipped).toEqual([]);
    expect(filtered.outOfCandidateRanges).toBe(0);
  });

  it("timeline scope: drops dense frames outside every candidate shot's padded range, before the blur gate", () => {
    // Shot 0 spans 0-10 -> padded range [-0.5, 10.5]. Frames at 1,5,9 fall
    // inside; 12 and 30 (inside shots 1/2, not candidates) fall outside.
    const dossier = makeDossier({ denseFrames: frames });
    const plan = planCloudFrames(dossier, "timeline", {
      candidateShotIndexes: new Set([0]),
    });
    expect(plan.frames.map((f) => f.t)).toEqual([1, 5, 9]);
    expect(plan.outOfCandidateRanges).toBe(2); // 12 and 30 dropped silently
    expect(plan.blurrySkipped).toEqual([]); // out-of-range frames are NOT blurry-skipped
  });

  it("blur gate still applies to frames that ARE inside a candidate range", () => {
    const dossier = makeDossier({
      denseFrames: [
        { t: 1, dataUrl: "f1", sharpness: 400 },
        { t: 5, dataUrl: "f5", sharpness: BLUR_SHARPNESS_THRESHOLD - 1 }, // inside shot 0, blurry
        { t: 30, dataUrl: "f30", sharpness: 400 }, // outside shot 0 entirely
      ],
      denseCaptions: [cap(1, "temple gate"), cap(30, "market stall")],
    });
    const plan = planCloudFrames(dossier, "timeline", {
      candidateShotIndexes: new Set([0]),
    });
    expect(plan.frames.map((f) => f.t)).toEqual([1]);
    expect(plan.blurrySkipped.map((f) => f.t)).toEqual([5]);
    expect(plan.outOfCandidateRanges).toBe(1); // the 30s frame
  });

  it("unset candidateShotIndexes leaves behavior identical to before (shots and timeline)", () => {
    const dossier = makeDossier({
      denseFrames: frames,
      denseCaptions: [
        cap(1, "road with trees and blue sky"),
        cap(5, "road with trees and blue sky ahead"),
        cap(9, "road with trees and sky"),
        cap(12, "a market stall piled with durians"),
        cap(30, "vendor weighing durians at a market stall"),
      ],
    });
    const noOpts = planCloudFrames(dossier, "timeline");
    const emptyOpts = planCloudFrames(dossier, "timeline", {});
    expect(emptyOpts).toEqual(noOpts);
    expect(noOpts.outOfCandidateRanges).toBe(0);

    const noOptsShots = planCloudFrames(dossier, "shots");
    const emptyOptsShots = planCloudFrames(dossier, "shots", {});
    expect(emptyOptsShots).toEqual(noOptsShots);
  });
});

describe("selectCloudFrames candidateShotIndexes", () => {
  it("restricts shots scope to the given indexes; timeline scope ignores it", () => {
    const dossier = makeDossier({ denseFrames: frames });
    expect(selectCloudFrames(dossier, "shots", new Set([1])).map((f) => f.t)).toEqual([12]);
    expect(selectCloudFrames(dossier, "shots")).toEqual(selectCloudFrames(dossier, "shots", undefined));
    expect(selectCloudFrames(dossier, "timeline", new Set([0]))).toEqual(frames);
  });
});
