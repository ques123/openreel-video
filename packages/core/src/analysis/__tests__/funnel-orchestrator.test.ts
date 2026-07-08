import { describe, expect, it } from "vitest";
import { BLUR_SHARPNESS_THRESHOLD } from "../cloud-vision-plan";
import { planLocalCaptionFrames, salvageCloudTranscript } from "../funnel-orchestrator";
import { DossierCache, serializeDossier, staleDossierCacheKeys } from "../dossier-cache";
import { DOSSIER_VERSION, type DenseCaption, type DenseFrame } from "../types";
import { makeCloudTranscript, makeDossier } from "./director-fixtures";
import type { StorageEngine } from "../../storage/storage-engine";
import type { CacheRecord } from "../../storage/types";

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

// salvageCloudTranscript is the pure decision behind carrying an opt-in
// cloud STT result across a DOSSIER_VERSION bump (see maybeFinish, which
// calls it with the freshly-analyzed dossier's own cloudTranscript and
// whatever analyzeFile salvaged from a stale-version cache hit before the
// run started). The worker-mediated run that surrounds it is exercised in
// the lab, same coverage boundary as planLocalCaptionFrames above.
describe("salvageCloudTranscript", () => {
  it("keeps the run's own cloudTranscript — never clobbers real work", () => {
    const fresh = makeCloudTranscript({ model: "fresh-run" });
    const salvaged = makeCloudTranscript({ model: "salvaged-run" });
    expect(salvageCloudTranscript(fresh, salvaged)).toBe(fresh);
  });

  it("falls back to the salvaged value when the fresh run has none", () => {
    const salvaged = makeCloudTranscript({ model: "salvaged-run" });
    expect(salvageCloudTranscript(undefined, salvaged)).toBe(salvaged);
    expect(salvageCloudTranscript(null, salvaged)).toBe(salvaged);
  });

  it("stays absent when neither side has a cloudTranscript", () => {
    expect(salvageCloudTranscript(undefined, null)).toBeNull();
    expect(salvageCloudTranscript(null, undefined)).toBeUndefined();
    expect(salvageCloudTranscript(undefined, undefined)).toBeUndefined();
  });
});

/**
 * Thin integration slice (no worker/orchestrator instance): the same two
 * real calls analyzeFile/maybeFinish chain together — loadStaleCloudTranscript
 * reading a serialized stale record, then salvageCloudTranscript deciding
 * whether it reaches the fresh dossier — with nothing faked except the
 * storage transport itself.
 */
describe("salvage integration: stale cloudTranscript reaches a fresh dossier", () => {
  it("survives the real serialize -> loadStaleCloudTranscript -> salvageCloudTranscript path", async () => {
    const file = new File([new Uint8Array(4)], "clip.mp4", { lastModified: 222 });
    const staleVersion = DOSSIER_VERSION - 1;
    const key = staleDossierCacheKeys(file).find((k) => k.version === staleVersion)!.key;
    const staleCloudTranscript = makeCloudTranscript({ model: "whisper-large-v3-turbo" });
    const record: CacheRecord = {
      key,
      data: serializeDossier(makeDossier({ cloudTranscript: staleCloudTranscript })),
      timestamp: 0,
      size: 0,
    };
    const cache = new DossierCache({
      async loadCache(k: string) {
        return k === key ? record : null;
      },
    } as unknown as StorageEngine);

    const salvaged = await cache.loadStaleCloudTranscript(file, staleVersion);
    const freshDossier = makeDossier(); // analysis produced no cloudTranscript of its own
    freshDossier.cloudTranscript = salvageCloudTranscript(freshDossier.cloudTranscript, salvaged);

    expect(freshDossier.cloudTranscript).toEqual(staleCloudTranscript);
  });

  it("never overwrites a cloudTranscript the fresh run produced itself", async () => {
    const file = new File([new Uint8Array(4)], "clip.mp4", { lastModified: 333 });
    const staleVersion = DOSSIER_VERSION - 1;
    const key = staleDossierCacheKeys(file).find((k) => k.version === staleVersion)!.key;
    const record: CacheRecord = {
      key,
      data: serializeDossier(
        makeDossier({ cloudTranscript: makeCloudTranscript({ model: "stale-salvage-candidate" }) }),
      ),
      timestamp: 0,
      size: 0,
    };
    const cache = new DossierCache({
      async loadCache(k: string) {
        return k === key ? record : null;
      },
    } as unknown as StorageEngine);

    const salvaged = await cache.loadStaleCloudTranscript(file, staleVersion);
    const ownCloudTranscript = makeCloudTranscript({ model: "this-runs-own-result" });
    const freshDossier = makeDossier({ cloudTranscript: ownCloudTranscript });
    freshDossier.cloudTranscript = salvageCloudTranscript(freshDossier.cloudTranscript, salvaged);

    expect(freshDossier.cloudTranscript).toEqual(ownCloudTranscript);
  });
});
