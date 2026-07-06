/**
 * Spend-guardrail math: the pre-enhance $ preview (calibrated against the
 * measured 91-clip run), the (scope, model) selection keying that stops a
 * model switch from hiding un-enhanced clips, re-enhance replacement/shrink
 * detection, and the session aux-spend rollup.
 */

import { describe, expect, it } from "vitest";
import type { CloudRunMeta, CloudScope } from "@openreel/core";
import {
  assessReEnhance,
  buildReEnhanceConfirm,
  estimateEnhanceCost,
  formatAuxSpend,
  formatCostPreview,
  hasCloudRun,
  sumAuxSpend,
  type CloudRunHistory,
  type ReEnhanceReplacement,
} from "./enhance-cost";

const meta = (model: string, framesSent = 100): CloudRunMeta => ({
  model,
  enhancedAt: 0,
  framesSent,
  framesFailed: 0,
  ms: 0,
  promptTokens: 0,
  completionTokens: 0,
});

const dossierWith = (
  archive: { scope: CloudScope; model: string; framesSent?: number }[],
  runs?: { shots?: CloudRunMeta | null; timeline?: CloudRunMeta | null },
): CloudRunHistory => ({
  cloudRuns: { shots: runs?.shots ?? null, timeline: runs?.timeline ?? null },
  cloudRunArchive: archive.map((a) => ({
    scope: a.scope,
    model: a.model,
    captions: [],
    meta: meta(a.model, a.framesSent ?? 100),
  })),
});

const plan = (clipId: string, frames: number, preMergeFrames = frames) => ({
  clipId,
  fileName: `${clipId}.mp4`,
  frames,
  preMergeFrames,
});

describe("estimateEnhanceCost", () => {
  it("aggregates frames and prices them with the per-frame profile", () => {
    const preview = estimateEnhanceCost(
      [plan("a", 100, 200), plan("b", 112, 140)],
      "gpt-5.4-mini",
    );
    expect(preview.clips).toBe(2);
    expect(preview.frames).toBe(212);
    expect(preview.preMergeFrames).toBe(340);
    // 212 * 200 in @ $0.75/M + 212 * 65 out @ $4.50/M
    expect(preview.estUSD).toBeCloseTo(0.0938, 3);
  });

  it("returns null cost for a model missing from the pricing table", () => {
    expect(estimateEnhanceCost([plan("a", 50)], "made-up-model").estUSD).toBeNull();
  });

  it("stays calibrated to the measured 91-clip run ($0.55 mini / $1.56 flagship)", () => {
    const measured = [plan("trip", 1253)];
    const mini = estimateEnhanceCost(measured, "gpt-5.4-mini").estUSD;
    const flagship = estimateEnhanceCost(measured, "gpt-5.2").estUSD;
    expect(mini).toBeGreaterThan(0.45);
    expect(mini).toBeLessThan(0.65);
    expect(flagship).toBeGreaterThan(1.4);
    expect(flagship).toBeLessThan(1.75);
  });
});

describe("formatCostPreview", () => {
  it("shows the merge saving as before→after when the merge saved frames", () => {
    const preview = estimateEnhanceCost([plan("a", 212, 340)], "gpt-5.4-mini");
    expect(formatCostPreview(preview)).toBe("≈$0.09 · 340→212 frames");
  });

  it("shows a plain frame count when nothing merged", () => {
    const preview = estimateEnhanceCost([plan("a", 1)], "gpt-5.4-mini");
    expect(formatCostPreview(preview)).toBe("≈<$0.01 · 1 frame");
  });

  it("omits the $ part for unpriced models", () => {
    const preview = estimateEnhanceCost([plan("a", 212, 340)], "made-up-model");
    expect(formatCostPreview(preview)).toBe("340→212 frames");
  });
});

describe("hasCloudRun — (scope, model) selection keying", () => {
  it("is false for a missing dossier", () => {
    expect(hasCloudRun(null, "shots", "gpt-5.2")).toBe(false);
    expect(hasCloudRun(undefined, "shots", "gpt-5.2")).toBe(false);
  });

  it("matches an archived run for the exact scope AND model", () => {
    const d = dossierWith([{ scope: "shots", model: "gpt-5.2" }]);
    expect(hasCloudRun(d, "shots", "gpt-5.2")).toBe(true);
    expect(hasCloudRun(d, "timeline", "gpt-5.2")).toBe(false);
  });

  it("does NOT count a same-scope run by a DIFFERENT model (the old bug)", () => {
    const d = dossierWith([{ scope: "shots", model: "gpt-5.2" }], {
      shots: meta("gpt-5.2"),
    });
    expect(hasCloudRun(d, "shots", "gpt-5.4-mini")).toBe(false);
  });

  it("falls back to the current-run meta for legacy dossiers without archive entries", () => {
    const d = dossierWith([], { shots: meta("gpt-5.4-mini") });
    expect(hasCloudRun(d, "shots", "gpt-5.4-mini")).toBe(true);
    expect(hasCloudRun(d, "shots", "gpt-5.2")).toBe(false);
    const legacy = { cloudRuns: { shots: meta("gpt-5.2"), timeline: null } };
    expect(hasCloudRun(legacy as unknown as CloudRunHistory, "shots", "gpt-5.2")).toBe(true);
  });
});

describe("assessReEnhance", () => {
  const target = (
    clipId: string,
    frames: number,
    dossier: CloudRunHistory | null,
  ) => ({ ...plan(clipId, frames), dossier });

  it("reports nothing for first-time enhances", () => {
    const impact = assessReEnhance(
      [target("a", 90, dossierWith([])), target("b", 10, null)],
      "shots",
      "gpt-5.4-mini",
    );
    expect(impact.replacing).toEqual([]);
    expect(impact.shrinking).toEqual([]);
  });

  it("flags replacements for the exact (scope, model) only", () => {
    const impact = assessReEnhance(
      [
        target("hit", 90, dossierWith([{ scope: "shots", model: "gpt-5.4-mini" }])),
        target("otherModel", 90, dossierWith([{ scope: "shots", model: "gpt-5.2" }])),
        target("otherScope", 90, dossierWith([{ scope: "timeline", model: "gpt-5.4-mini" }])),
      ],
      "shots",
      "gpt-5.4-mini",
    );
    expect(impact.replacing).toEqual([
      { clipId: "hit", fileName: "hit.mp4", archivedFrames: 100, plannedFrames: 90 },
    ]);
    expect(impact.shrinking).toEqual([]);
  });

  it("marks a replacement as shrinking only below half the archived frames", () => {
    const archive = [{ scope: "shots" as const, model: "m", framesSent: 100 }];
    const impact = assessReEnhance(
      [
        target("shrinks", 49, dossierWith(archive)),
        target("boundary", 50, dossierWith(archive)),
      ],
      "shots",
      "m",
    );
    expect(impact.replacing).toHaveLength(2);
    expect(impact.shrinking.map((r) => r.clipId)).toEqual(["shrinks"]);
  });

  it("falls back to the current-run meta when the archive lacks the entry", () => {
    const impact = assessReEnhance(
      [target("a", 39, dossierWith([], { timeline: meta("gpt-5.2", 80) }))],
      "timeline",
      "gpt-5.2",
    );
    expect(impact.replacing).toEqual([
      { clipId: "a", fileName: "a.mp4", archivedFrames: 80, plannedFrames: 39 },
    ]);
    expect(impact.shrinking).toHaveLength(1);
  });
});

describe("buildReEnhanceConfirm", () => {
  const preview = estimateEnhanceCost([plan("a", 212, 340)], "gpt-5.4-mini");
  const rep = (clipId: string, archived: number, planned: number): ReEnhanceReplacement => ({
    clipId,
    fileName: `${clipId}.mp4`,
    archivedFrames: archived,
    plannedFrames: planned,
  });

  it("returns null when nothing would be replaced (no confirm for first-time runs)", () => {
    expect(
      buildReEnhanceConfirm({ replacing: [], shrinking: [] }, "shots", "gpt-5.4-mini", preview),
    ).toBeNull();
  });

  it("names the (scope, model), counts, cost preview, and asks to continue", () => {
    const msg = buildReEnhanceConfirm(
      { replacing: [rep("a", 100, 90), rep("b", 50, 45)], shrinking: [] },
      "shots",
      "gpt-5.4-mini",
      preview,
    );
    expect(msg).toContain("2 clips already have a (shots, gpt-5.4-mini) enhance");
    expect(msg).toContain("≈$0.09 · 340→212 frames");
    expect(msg).toContain("Continue?");
    expect(msg).not.toContain("SMALLER");
  });

  it("folds the shrink warning in, with examples capped at 3", () => {
    const shrinking = [
      rep("a", 212, 40),
      rep("b", 180, 22),
      rep("c", 150, 30),
      rep("d", 140, 20),
      rep("e", 130, 10),
    ];
    const msg = buildReEnhanceConfirm(
      { replacing: shrinking, shrinking },
      "timeline",
      "gpt-5.2",
      preview,
    );
    expect(msg).toContain("5 replacements would be much SMALLER");
    expect(msg).toContain("a.mp4: 212 → 40 frames");
    expect(msg).toContain("c.mp4: 150 → 30 frames");
    expect(msg).not.toContain("d.mp4");
    expect(msg).toContain("…and 2 more");
  });
});

describe("aux spend rollup", () => {
  const usage = (model: string, prompt: number, completion: number, cached = 0) => ({
    model,
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
  });

  it("sums priced calls, applying the cached-input discount", () => {
    const spend = sumAuxSpend([
      // 5k full-rate in + 5k cached in @10% + 1k out on gpt-5.4-mini
      usage("gpt-5.4-mini", 10_000, 1_000, 5_000),
      usage("gpt-5.4-mini", 1_000, 100),
    ]);
    expect(spend.calls).toBe(2);
    expect(spend.promptTokens).toBe(11_000);
    expect(spend.completionTokens).toBe(1_100);
    expect(spend.unpricedCalls).toBe(0);
    expect(spend.usd).toBeCloseTo(0.008625 + 0.0012, 5);
    expect(formatAuxSpend(spend)).toBe("<$0.01 · 2 calls");
  });

  it("excludes unpriced models from the $ sum and marks the total as a floor", () => {
    const spend = sumAuxSpend([
      usage("gpt-5.4-mini", 100_000, 100_000),
      usage("mystery-model", 5_000, 500),
    ]);
    expect(spend.unpricedCalls).toBe(1);
    expect(spend.usd).toBeCloseTo(0.525, 3);
    expect(formatAuxSpend(spend)).toBe("≥$0.53 · 2 calls");
  });

  it("handles the empty session", () => {
    const spend = sumAuxSpend([]);
    expect(spend).toEqual({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      usd: 0,
      unpricedCalls: 0,
    });
    expect(formatAuxSpend(spend)).toBe("$0.00 · 0 calls");
  });
});
