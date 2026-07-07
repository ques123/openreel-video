import { describe, expect, it } from "vitest";
import type { ClipDossier, FunnelProgressEvent, Shot } from "@openreel/core";
import {
  applyModelEvent,
  buildRateTracker,
  checkMaxClipsCap,
  deriveAllReady,
  deriveBatch,
  deriveClipStatus,
  deriveModelPrep,
  initialModelTrackerState,
  initialPipelineState,
  knownTotalSeconds,
  pipelineReducer,
  toPublicClip,
  withReadyStamp,
  wouldExceedMaxTotalSeconds,
  type PipelineState,
  type RawClipState,
} from "./pipeline-state";

function withEvent(state: PipelineState, event: FunnelProgressEvent, atMs = 0): PipelineState {
  return pipelineReducer(state, { type: "event", event, atMs });
}

function added(state: PipelineState, id: string, atMs = 0): PipelineState {
  return pipelineReducer(state, { type: "clip-added", id, fileName: `${id}.mp4`, atMs });
}

function fixtureShot(overrides: Partial<Shot> = {}): Shot {
  return {
    index: 0,
    tStart: 0,
    tEnd: 2,
    repFrameTime: 1,
    thumbnailDataUrl: "data:image/jpeg;base64,AAA",
    embedding: null,
    frameEmbeddings: [],
    motion: { score: 10, peakTime: 1 },
    quality: { sharpness: 200 },
    caption: null,
    cloudCaption: null,
    ...overrides,
  };
}

function fixtureDossier(overrides: Partial<ClipDossier> = {}): ClipDossier {
  return {
    version: 4,
    clipId: "c1",
    cacheKey: "k",
    fileName: "c1.mp4",
    recordedAt: null,
    durationS: 30,
    analyzedThroughS: null,
    width: 1920,
    height: 1080,
    shots: [],
    denseFrames: [],
    denseCaptions: [],
    cloudDenseCaptions: [],
    cloudShotCaptions: [],
    cloudRuns: { shots: null, timeline: null },
    cloudRunArchive: [],
    cloudVision: null,
    localCaptionPerf: null,
    transcript: [],
    perf: {
      ingestMs: 0,
      usedOpfs: false,
      decodeMs: 0,
      framesDecoded: 0,
      analysisFps: 0,
      realtimeFactor: 0,
      embedMs: 0,
      embedPerFrameMs: 0,
      audioDecodeMs: 0,
      whisperMs: 0,
      whisperRealtimeFactor: 0,
      modelLoadMs: { clip: 0, whisper: 0 },
      totalMs: 0,
      device: { embed: null, whisper: null },
      cacheHit: false,
    },
    ...overrides,
  } as ClipDossier;
}

// ---------------------------------------------------------------------------
// pipelineReducer
// ---------------------------------------------------------------------------

describe("pipelineReducer — clip-added / clip-removed", () => {
  it("adds a fresh clip in the queued (unstarted) state", () => {
    const state = added(initialPipelineState, "c1", 1000);
    expect(state.clips).toHaveLength(1);
    expect(state.clips[0]).toMatchObject({ id: "c1", fileName: "c1.mp4", addedAtMs: 1000, outcome: "analyzing" });
    expect(deriveClipStatus(state.clips[0])).toEqual({ kind: "queued" });
  });

  it("re-adding an existing id resets it to a fresh state (retryClip semantics)", () => {
    let state = added(initialPipelineState, "c1", 0);
    state = withEvent(state, { kind: "meta", clipId: "c1", durationS: 30, width: 1, height: 1, analyzedThroughS: null });
    state = withEvent(state, { kind: "clip-error", clipId: "c1", message: "boom" });
    expect(state.clips[0].outcome).toBe("error");

    state = added(state, "c1", 500);
    expect(state.clips).toHaveLength(1); // same row, not a duplicate
    expect(state.clips[0]).toMatchObject({ id: "c1", outcome: "analyzing", addedAtMs: 500, durationS: 0 });
  });

  it("clip-removed drops the clip", () => {
    let state = added(initialPipelineState, "c1");
    state = added(state, "c2");
    state = pipelineReducer(state, { type: "clip-removed", id: "c1" });
    expect(state.clips.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("pipelineReducer — event handling", () => {
  it("meta sets durationS and metaKnown", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "meta", clipId: "c1", durationS: 42, width: 100, height: 200, analyzedThroughS: null });
    expect(state.clips[0]).toMatchObject({ durationS: 42, metaKnown: true });
  });

  it("ingest-progress sets a 0..1 fraction from bytesDone/bytesTotal", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "ingest-progress", clipId: "c1", bytesDone: 40, bytesTotal: 80 });
    expect(state.clips[0].ingestProgress).toBe(0.5);
  });

  it("decode-progress sets decodeT and clears ingestProgress", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "ingest-progress", clipId: "c1", bytesDone: 1, bytesTotal: 1 });
    state = withEvent(state, { kind: "decode-progress", clipId: "c1", t: 5, framesDone: 10 });
    expect(state.clips[0]).toMatchObject({ decodeT: 5, ingestProgress: null });
  });

  it("ingest-window records the rolling-window pass info", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "ingest-window", clipId: "c1", window: 2, windows: 3, analyzedThroughS: 100 });
    expect(state.clips[0].ingestWindow).toEqual({ window: 2, windows: 3 });
  });

  it("the FIRST shot's thumbnail becomes the clip's thumbnailUrl; later shots don't overwrite it", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "shot", clipId: "c1", shot: fixtureShot({ thumbnailDataUrl: "first" }) });
    state = withEvent(state, { kind: "shot", clipId: "c1", shot: fixtureShot({ index: 1, thumbnailDataUrl: "second" }) });
    expect(state.clips[0].thumbnailUrl).toBe("first");
  });

  it("dense-captions sets captionsDone/captionsTotal", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "dense-captions", clipId: "c1", done: 3, total: 10 });
    expect(state.clips[0]).toMatchObject({ captionsDone: 3, captionsTotal: 10 });
  });

  it("transcript marks transcriptReceived", () => {
    let state = added(initialPipelineState, "c1");
    expect(state.clips[0].transcriptReceived).toBe(false);
    state = withEvent(state, { kind: "transcript", clipId: "c1", segments: [] });
    expect(state.clips[0].transcriptReceived).toBe(true);
  });

  it("clip-done sets outcome done and stamps readyAtMs immediately when there are no dense frames to caption", () => {
    let state = added(initialPipelineState, "c1", 0);
    const dossier = fixtureDossier({ denseFrames: [] });
    state = withEvent(state, { kind: "clip-done", clipId: "c1", dossier }, 5000);
    expect(state.clips[0]).toMatchObject({ outcome: "done", durationS: 30, readyAtMs: 5000 });
  });

  it("clip-done leaves readyAtMs null when there ARE dense frames still to caption", () => {
    let state = added(initialPipelineState, "c1", 0);
    const dossier = fixtureDossier({ denseFrames: [{ t: 0, dataUrl: "x" }] });
    state = withEvent(state, { kind: "clip-done", clipId: "c1", dossier }, 5000);
    expect(state.clips[0]).toMatchObject({ outcome: "done", readyAtMs: null });
  });

  it("clip-error (real failure) sets outcome error with the message", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "clip-error", clipId: "c1", message: "decode failed" });
    expect(state.clips[0]).toMatchObject({ outcome: "error", errorMessage: "decode failed" });
  });

  it("clip-error with cancelled:true REMOVES the clip (cap-driven internal cancellation, not a user-visible error)", () => {
    let state = added(initialPipelineState, "c1");
    state = added(state, "c2");
    state = withEvent(state, { kind: "clip-error", clipId: "c1", message: "cancelled", cancelled: true });
    expect(state.clips.map((c) => c.id)).toEqual(["c2"]);
  });

  it("an unhandled event kind (e.g. shot-embedded/audio-signals) is a no-op", () => {
    let state = added(initialPipelineState, "c1");
    const before = state;
    state = withEvent(state, { kind: "shot-embedded", clipId: "c1", shotIndex: 0 });
    expect(state).toEqual(before);
  });

  it("an event referencing an unknown clipId is a harmless no-op", () => {
    const state = withEvent(initialPipelineState, { kind: "transcript", clipId: "ghost", segments: [] });
    expect(state.clips).toEqual([]);
  });
});

describe("withReadyStamp", () => {
  const base: RawClipState = {
    id: "c1",
    fileName: "c1.mp4",
    addedAtMs: 0,
    durationS: 10,
    metaKnown: true,
    thumbnailUrl: null,
    ingestProgress: null,
    decodeT: 10,
    ingestWindow: null,
    transcriptReceived: true,
    captionsDone: 0,
    captionsTotal: 0,
    outcome: "done",
    readyAtMs: null,
    dossier: null,
  };

  it("stamps readyAtMs when done and there's nothing to caption", () => {
    expect(withReadyStamp(base, 999).readyAtMs).toBe(999);
  });

  it("does not stamp while captions are still catching up", () => {
    const clip = { ...base, captionsTotal: 5, captionsDone: 2 };
    expect(withReadyStamp(clip, 999).readyAtMs).toBeNull();
  });

  it("stamps once captions catch up", () => {
    const clip = { ...base, captionsTotal: 5, captionsDone: 5 };
    expect(withReadyStamp(clip, 999).readyAtMs).toBe(999);
  });

  it("is a no-op once already stamped (first stamp wins)", () => {
    const clip = { ...base, readyAtMs: 111 };
    expect(withReadyStamp(clip, 999).readyAtMs).toBe(111);
  });

  it("is a no-op for a clip that isn't done yet", () => {
    const clip = { ...base, outcome: "analyzing" as const };
    expect(withReadyStamp(clip, 999).readyAtMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveClipStatus / toPublicClip / deriveAllReady
// ---------------------------------------------------------------------------

describe("deriveClipStatus", () => {
  const base: RawClipState = {
    id: "c1",
    fileName: "c1.mp4",
    addedAtMs: 0,
    durationS: 0,
    metaKnown: false,
    thumbnailUrl: null,
    ingestProgress: null,
    decodeT: 0,
    ingestWindow: null,
    transcriptReceived: false,
    captionsDone: 0,
    captionsTotal: 0,
    outcome: "analyzing",
    readyAtMs: null,
    dossier: null,
  };

  it("queued: analyzing with no signal at all yet", () => {
    expect(deriveClipStatus(base)).toEqual({ kind: "queued" });
  });

  it("watching your footage during ingest (progress scaled to the first half of the stage bar)", () => {
    const clip = { ...base, ingestProgress: 0.4 };
    expect(deriveClipStatus(clip)).toEqual({
      kind: "analyzing",
      stageLabel: "watching your footage",
      progress: 0.2,
      pass: undefined,
    });
  });

  it("watching your footage during decode (progress scaled to the second half of the stage bar)", () => {
    const clip = { ...base, metaKnown: true, durationS: 100, decodeT: 50 };
    expect(deriveClipStatus(clip)).toEqual({
      kind: "analyzing",
      stageLabel: "watching your footage",
      progress: 0.75,
      pass: undefined,
    });
  });

  it("includes pass info for a multi-window rolling ingest", () => {
    const clip = { ...base, ingestProgress: 0.1, ingestWindow: { window: 2, windows: 4 } };
    const status = deriveClipStatus(clip);
    expect(status.kind).toBe("analyzing");
    expect((status as { pass?: { current: number; total: number } }).pass).toEqual({ current: 2, total: 4 });
  });

  it("omits pass info for a single-window clip even if ingestWindow is set", () => {
    const clip = { ...base, ingestProgress: 0.1, ingestWindow: { window: 1, windows: 1 } };
    expect((deriveClipStatus(clip) as { pass?: unknown }).pass).toBeUndefined();
  });

  it("listening for speech: visual done, transcript not yet in — progress stays 0 (no incremental signal, never faked)", () => {
    const clip = { ...base, metaKnown: true, durationS: 10, decodeT: 10 };
    expect(deriveClipStatus(clip)).toEqual({
      kind: "analyzing",
      stageLabel: "listening for speech",
      progress: 0,
      pass: undefined,
    });
  });

  it("describing what it sees: real captionsDone/captionsTotal progress", () => {
    const clip = {
      ...base,
      metaKnown: true,
      durationS: 10,
      decodeT: 10,
      transcriptReceived: true,
      captionsTotal: 8,
      captionsDone: 2,
    };
    expect(deriveClipStatus(clip)).toEqual({
      kind: "analyzing",
      stageLabel: "describing what it sees",
      progress: 0.25,
      pass: undefined,
    });
  });

  it("ready: outcome done and nothing left to caption", () => {
    const clip = {
      ...base,
      metaKnown: true,
      durationS: 10,
      decodeT: 10,
      transcriptReceived: true,
      outcome: "done" as const,
    };
    expect(deriveClipStatus(clip)).toEqual({ kind: "ready" });
  });

  it("error: retryable, uses the recorded message", () => {
    const clip = { ...base, outcome: "error" as const, errorMessage: "no audio track" };
    expect(deriveClipStatus(clip)).toEqual({ kind: "error", message: "no audio track", retryable: true });
  });

  it("error: falls back to a generic message when none was recorded", () => {
    const clip = { ...base, outcome: "error" as const };
    expect(deriveClipStatus(clip).kind).toBe("error");
  });
});

describe("toPublicClip", () => {
  it("maps id/name/status, and durationS is null until meta is known", () => {
    const clip: RawClipState = {
      id: "c1",
      fileName: "beach.mp4",
      addedAtMs: 0,
      durationS: 30,
      metaKnown: false,
      thumbnailUrl: "thumb",
      ingestProgress: null,
      decodeT: 0,
      ingestWindow: null,
      transcriptReceived: false,
      captionsDone: 0,
      captionsTotal: 0,
      outcome: "analyzing",
      readyAtMs: null,
      dossier: null,
    };
    expect(toPublicClip(clip)).toEqual({
      id: "c1",
      name: "beach.mp4",
      durationS: null,
      thumbnailUrl: "thumb",
      status: { kind: "queued" },
    });
    expect(toPublicClip({ ...clip, metaKnown: true }).durationS).toBe(30);
  });
});

describe("deriveAllReady", () => {
  it("false for an empty clip list", () => {
    expect(deriveAllReady([])).toBe(false);
  });

  it("false when any clip isn't ready", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "clip-done", clipId: "c1", dossier: fixtureDossier({ denseFrames: [] }) });
    state = added(state, "c2");
    expect(deriveAllReady(state.clips)).toBe(false);
  });

  it("true once every clip reads ready", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "clip-done", clipId: "c1", dossier: fixtureDossier({ denseFrames: [] }) });
    expect(deriveAllReady(state.clips)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batch ETA
// ---------------------------------------------------------------------------

describe("buildRateTracker / deriveBatch", () => {
  it("null for an empty clip list", () => {
    expect(deriveBatch([], 0)).toBeNull();
  });

  it("cold start (nothing finished yet this session): etaS is null, not fabricated", () => {
    let state = added(initialPipelineState, "c1", 0);
    state = withEvent(state, { kind: "meta", clipId: "c1", durationS: 60, width: 1, height: 1, analyzedThroughS: null });
    const batch = deriveBatch(state.clips, 5000);
    expect(batch).toEqual({ currentIndex: 1, total: 1, etaS: null });
  });

  it("once one clip finishes, its measured rate extrapolates the still-analyzing one", () => {
    let state = added(initialPipelineState, "c1", 0);
    state = added(state, "c2", 0);
    // c1: 60s of source content took 6000ms wall-clock -> 10x realtime.
    state = withEvent(state, { kind: "clip-done", clipId: "c1", dossier: fixtureDossier({ durationS: 60, denseFrames: [] }) }, 6000);
    // c2: known duration 30s, just started (elapsed 0 at nowMs=6000... use addedAtMs 6000 for a clean elapsed=0).
    state = pipelineReducer(state, { type: "clip-added", id: "c2", fileName: "c2.mp4", atMs: 6000 });
    state = withEvent(state, { kind: "meta", clipId: "c2", durationS: 30, width: 1, height: 1, analyzedThroughS: null }, 6000);

    const rates = buildRateTracker(state.clips);
    expect(rates.totalSourceS).toBe(60);
    expect(rates.totalWallMs).toBe(6000);

    const batch = deriveBatch(state.clips, 6000);
    expect(batch?.currentIndex).toBe(2); // 1 settled + the active one
    expect(batch?.total).toBe(2);
    // wallMsPerSourceS = 6000/60 = 100ms/s; 30s * 100ms/s = 3000ms = 3s; elapsed 0 -> remaining 3s.
    expect(batch?.etaS).toBeCloseTo(3);
  });

  it("a still-queued clip with unknown duration uses the average of clips whose duration IS known", () => {
    // c1 finishes: 40s of content in 4000ms wall-clock -> 100ms of wall-clock per source-second.
    let state = added(initialPipelineState, "c1", 0);
    state = withEvent(
      state,
      { kind: "clip-done", clipId: "c1", dossier: fixtureDossier({ durationS: 40, denseFrames: [] }) },
      4000,
    );
    // c2: known duration 20s, just added (elapsed 0 at nowMs=4000).
    state = added(state, "c2", 4000);
    state = withEvent(state, { kind: "meta", clipId: "c2", durationS: 20, width: 1, height: 1, analyzedThroughS: null }, 4000);
    // c3: duration never became known -> must fall back to the average of c1+c2's known durations (40+20)/2 = 30.
    state = added(state, "c3", 4000);

    const batch = deriveBatch(state.clips, 4000);
    expect(batch?.currentIndex).toBe(2); // 1 settled + the active one
    expect(batch?.total).toBe(3);
    // c1 settled -> 0. c2: 20s * 100ms/s = 2000ms = 2s (elapsed 0). c3 (avg 30s): 30*100ms/s = 3000ms = 3s (elapsed 0).
    expect(batch?.etaS).toBeCloseTo(5);
  });

  it("all clips settled (ready or error) -> null, so the bench drops the batch line instead of freezing on 'clip N of N'", () => {
    let state = added(initialPipelineState, "c1", 0);
    state = withEvent(state, { kind: "clip-done", clipId: "c1", dossier: fixtureDossier({ durationS: 10, denseFrames: [] }) }, 1000);
    state = added(state, "c2", 0);
    state = withEvent(state, { kind: "clip-error", clipId: "c2", message: "boom" });
    expect(deriveBatch(state.clips, 1000)).toBeNull();
  });

  it("still reports a batch while at least one clip is analyzing, currentIndex = settled + 1", () => {
    let state = added(initialPipelineState, "c1", 0);
    state = withEvent(state, { kind: "clip-done", clipId: "c1", dossier: fixtureDossier({ durationS: 10, denseFrames: [] }) }, 1000);
    state = added(state, "c2", 0); // still analyzing
    const batch = deriveBatch(state.clips, 1000);
    expect(batch?.currentIndex).toBe(2);
    expect(batch?.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Model prep
// ---------------------------------------------------------------------------

describe("applyModelEvent / deriveModelPrep", () => {
  it("returns null once every tracked model is ready (never shown again)", () => {
    let state = initialModelTrackerState;
    for (const model of ["embed", "whisper", "captioner"] as const) {
      state = applyModelEvent(state, { kind: "model-ready", model, device: "wasm", loadMs: 10 });
    }
    expect(deriveModelPrep(state)).toBeNull();
  });

  it("sums multiple files' progress within ONE model rather than overwriting", () => {
    let state = initialModelTrackerState;
    state = applyModelEvent(state, { kind: "model-progress", model: "embed", file: "a.onnx", loaded: 50, total: 100 });
    state = applyModelEvent(state, { kind: "model-progress", model: "embed", file: "b.onnx", loaded: 0, total: 100 });
    // embed: 50/200 = 0.25; whisper/captioner haven't started (contribute 0) -> (0.25+0+0)/3.
    expect(deriveModelPrep(state)).toEqual({ progress: 0.25 / 3, done: false });
  });

  it("a model that's ready but never reported bytes (cache hit) still contributes its full share", () => {
    let state = initialModelTrackerState;
    state = applyModelEvent(state, { kind: "model-ready", model: "embed", device: "wasm", loadMs: 5 });
    // whisper/captioner not ready, no progress reported at all.
    expect(deriveModelPrep(state)).toEqual({ progress: 1 / 3, done: false });
  });

  it("never reads progress:1 while done is still false (a single fully-loaded model can't fake completion)", () => {
    let state = initialModelTrackerState;
    state = applyModelEvent(state, { kind: "model-progress", model: "embed", file: "a.onnx", loaded: 100, total: 100 });
    const prep = deriveModelPrep(state);
    expect(prep?.done).toBe(false);
    expect(prep?.progress).toBeLessThan(1);
  });

  it("ignores stray progress after a model is already marked ready", () => {
    let state = initialModelTrackerState;
    state = applyModelEvent(state, { kind: "model-ready", model: "embed", device: "wasm", loadMs: 5 });
    state = applyModelEvent(state, { kind: "model-progress", model: "embed", file: "a.onnx", loaded: 1, total: 100 });
    expect(state.embed.ready).toBe(true);
    expect(state.embed.files).toEqual({});
  });

  it("an unrelated event kind is a no-op", () => {
    const state = initialModelTrackerState;
    expect(applyModelEvent(state, { kind: "transcript", clipId: "c1", segments: [] })).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Footage cap
// ---------------------------------------------------------------------------

describe("checkMaxClipsCap", () => {
  const cap = { maxClips: 5, maxTotalSeconds: 3600 };

  it("allows everything when there's room", () => {
    expect(checkMaxClipsCap(2, 2, cap)).toEqual({ allowedCount: 2, refusedByMaxClips: 0 });
  });

  it("allows only up to the remaining room, refusing the rest", () => {
    expect(checkMaxClipsCap(3, 4, cap)).toEqual({ allowedCount: 2, refusedByMaxClips: 2 });
  });

  it("refuses everything once already at/over the cap", () => {
    expect(checkMaxClipsCap(5, 3, cap)).toEqual({ allowedCount: 0, refusedByMaxClips: 3 });
    expect(checkMaxClipsCap(9, 3, cap)).toEqual({ allowedCount: 0, refusedByMaxClips: 3 });
  });
});

describe("wouldExceedMaxTotalSeconds / knownTotalSeconds", () => {
  const cap = { maxClips: 25, maxTotalSeconds: 100 };

  it("true when the new clip would push the known total over the cap", () => {
    expect(wouldExceedMaxTotalSeconds(90, 20, cap)).toBe(true);
  });

  it("false when it fits exactly at the cap", () => {
    expect(wouldExceedMaxTotalSeconds(90, 10, cap)).toBe(false);
  });

  it("knownTotalSeconds sums every OTHER meta-known clip's duration", () => {
    let state = added(initialPipelineState, "c1");
    state = withEvent(state, { kind: "meta", clipId: "c1", durationS: 30, width: 1, height: 1, analyzedThroughS: null });
    state = added(state, "c2");
    state = withEvent(state, { kind: "meta", clipId: "c2", durationS: 20, width: 1, height: 1, analyzedThroughS: null });
    state = added(state, "c3"); // no meta yet -> excluded
    expect(knownTotalSeconds(state.clips, "c2")).toBe(30);
    expect(knownTotalSeconds(state.clips, "nonexistent")).toBe(50);
  });
});
