import { describe, expect, it } from "vitest";
import { applyCloudResults, selectCloudFrames } from "../cloud-vision-plan";
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
