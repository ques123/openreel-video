/**
 * Reducer-level tests for the event mappings added by the fleet-rollup /
 * cancel work: a deliberate cancelClip() lands the clip in a distinct
 * "cancelled" status (not "error"), a real failure still lands in "error"
 * with its message, and a "cache-invalidated" event flags staleReanalysis.
 * `reducer` and `initialState` are pure (no React) and exported from
 * use-perception-lab.ts specifically so this needs no DOM/render harness.
 */

import { describe, expect, it } from "vitest";
import { DOSSIER_VERSION, type ClipDossier, type FunnelProgressEvent } from "@openreel/core";
import {
  initialState,
  reducer,
  shouldAutoQueueCloudTranscribe,
  type LabState,
} from "./use-perception-lab";

function withClip(clipId = "clip-1", fileName = "a.mp4"): LabState {
  return reducer(initialState, {
    type: "clip-added",
    clipId,
    fileName,
    fileSize: 1000,
  });
}

function fire(state: LabState, event: FunnelProgressEvent): LabState {
  return reducer(state, { type: "event", event });
}

function clip(state: LabState, clipId = "clip-1") {
  const c = state.clips.find((x) => x.clipId === clipId);
  if (!c) throw new Error(`clip ${clipId} missing from state`);
  return c;
}

/** Minimal-but-valid ClipDossier for reducer tests that only care about
 * reference identity / the cloudTranscript field, not the rest of the shape. */
function fakeDossier(overrides: Partial<ClipDossier> = {}): ClipDossier {
  return {
    version: DOSSIER_VERSION,
    clipId: "clip-1",
    cacheKey: "perception:v4:a.mp4:1:1",
    fileName: "a.mp4",
    recordedAt: null,
    durationS: 10,
    analyzedThroughS: null,
    width: 100,
    height: 100,
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
  };
}

describe("reducer: clip-error / cancel mapping", () => {
  it("a cancelled clip-error lands in status 'cancelled' with no error text", () => {
    const state = fire(withClip(), {
      kind: "clip-error",
      clipId: "clip-1",
      message: "cancelled",
      cancelled: true,
    });
    expect(clip(state).status).toBe("cancelled");
    expect(clip(state).error).toBeUndefined();
  });

  it("a real clip-error (cancelled absent) lands in status 'error' with the message", () => {
    const state = fire(withClip(), {
      kind: "clip-error",
      clipId: "clip-1",
      message: "decode failed: corrupt header",
    });
    expect(clip(state).status).toBe("error");
    expect(clip(state).error).toBe("decode failed: corrupt header");
  });

  it("a clip-error with cancelled: false behaves like a real error, not a cancel", () => {
    const state = fire(withClip(), {
      kind: "clip-error",
      clipId: "clip-1",
      message: "decode failed",
      cancelled: false,
    });
    expect(clip(state).status).toBe("error");
    expect(clip(state).error).toBe("decode failed");
  });

  it("only updates the targeted clip, leaving sibling clips untouched", () => {
    let state = withClip("clip-1", "a.mp4");
    state = reducer(state, {
      type: "clip-added",
      clipId: "clip-2",
      fileName: "b.mp4",
      fileSize: 500,
    });
    state = fire(state, {
      kind: "clip-error",
      clipId: "clip-1",
      message: "cancelled",
      cancelled: true,
    });
    expect(clip(state, "clip-1").status).toBe("cancelled");
    expect(clip(state, "clip-2").status).toBe("analyzing");
  });

  it("an event for an id no longer in state (e.g. removed mid-flight) is a harmless no-op", () => {
    const before = withClip();
    const after = fire(before, {
      kind: "clip-error",
      clipId: "nonexistent-clip",
      message: "cancelled",
      cancelled: true,
    });
    expect(after.clips).toEqual(before.clips);
  });
});

describe("reducer: cache-invalidated (stale re-analysis label)", () => {
  it("flags the clip staleReanalysis on a cache-invalidated event", () => {
    const state = fire(withClip(), {
      kind: "cache-invalidated",
      clipId: "clip-1",
      previousVersion: 3,
    });
    expect(clip(state).staleReanalysis).toBe(true);
  });

  it("does not itself change status — the clip is still analyzing", () => {
    const state = fire(withClip(), {
      kind: "cache-invalidated",
      clipId: "clip-1",
      previousVersion: 3,
    });
    expect(clip(state).status).toBe("analyzing");
  });
});

describe("reducer: clip-removed", () => {
  it("drops the clip from state entirely", () => {
    let state = withClip("clip-1");
    state = reducer(state, {
      type: "clip-added",
      clipId: "clip-2",
      fileName: "b.mp4",
      fileSize: 500,
    });
    state = reducer(state, { type: "clip-removed", clipId: "clip-1" });
    expect(state.clips.map((c) => c.clipId)).toEqual(["clip-2"]);
  });
});

describe("reducer: cloud-transcribe-status", () => {
  it("a clip starts with no cloudTranscribe state", () => {
    expect(clip(withClip()).cloudTranscribe).toBeUndefined();
  });

  it("moves the clip through queued -> running -> error", () => {
    let state = withClip();
    state = reducer(state, {
      type: "cloud-transcribe-status",
      clipId: "clip-1",
      state: { status: "queued" },
    });
    expect(clip(state).cloudTranscribe).toEqual({ status: "queued" });

    state = reducer(state, {
      type: "cloud-transcribe-status",
      clipId: "clip-1",
      state: { status: "running" },
    });
    expect(clip(state).cloudTranscribe).toEqual({ status: "running" });

    state = reducer(state, {
      type: "cloud-transcribe-status",
      clipId: "clip-1",
      state: { status: "error", error: "groq stt: 500 server error" },
    });
    expect(clip(state).cloudTranscribe).toEqual({
      status: "error",
      error: "groq stt: 500 server error",
    });
  });

  it("only updates the targeted clip, leaving sibling clips untouched", () => {
    let state = withClip("clip-1", "a.mp4");
    state = reducer(state, {
      type: "clip-added",
      clipId: "clip-2",
      fileName: "b.mp4",
      fileSize: 500,
    });
    state = reducer(state, {
      type: "cloud-transcribe-status",
      clipId: "clip-1",
      state: { status: "running" },
    });
    expect(clip(state, "clip-1").cloudTranscribe).toEqual({ status: "running" });
    expect(clip(state, "clip-2").cloudTranscribe).toBeUndefined();
  });

  it("a status update for an id no longer in state (e.g. removed mid-queue) is a harmless no-op", () => {
    const before = withClip();
    const after = reducer(before, {
      type: "cloud-transcribe-status",
      clipId: "nonexistent-clip",
      state: { status: "running" },
    });
    expect(after.clips).toEqual(before.clips);
  });
});

describe("reducer: cloud-transcribe-done", () => {
  it("marks the clip done and replaces its dossier reference", () => {
    const state = withClip();
    const dossier = fakeDossier({
      cloudTranscript: {
        model: "whisper-large-v3-turbo",
        segments: [{ t0: 0, t1: 2, text: "hi there" }],
        words: null,
        billedSeconds: 10,
        costUSD: 0.00011,
        ms: 400,
        transcribedAt: 1720000000000,
      },
    });
    const after = reducer(state, { type: "cloud-transcribe-done", clipId: "clip-1", dossier });

    expect(clip(after).cloudTranscribe).toEqual({ status: "done" });
    // Reference identity, not just structural equality — the whole point is
    // that this is the SAME (mutated-in-place) dossier object the caller
    // already saved, not a fresh clone.
    expect(clip(after).dossier).toBe(dossier);
    expect(clip(after).dossier?.cloudTranscript?.segments[0].text).toBe("hi there");
  });

  it("overwrites a running/error state with done", () => {
    let state = withClip();
    state = reducer(state, {
      type: "cloud-transcribe-status",
      clipId: "clip-1",
      state: { status: "error", error: "boom" },
    });
    const dossier = fakeDossier();
    state = reducer(state, { type: "cloud-transcribe-done", clipId: "clip-1", dossier });
    expect(clip(state).cloudTranscribe).toEqual({ status: "done" });
  });

  it("a done event for an id no longer in state is a harmless no-op", () => {
    const before = withClip();
    const after = reducer(before, {
      type: "cloud-transcribe-done",
      clipId: "nonexistent-clip",
      dossier: fakeDossier(),
    });
    expect(after.clips).toEqual(before.clips);
  });
});

describe("shouldAutoQueueCloudTranscribe (auto-queue eligibility)", () => {
  const baseClip = clip(withClip());

  it("is false while the clip is still analyzing", () => {
    const dossier = fakeDossier({ audioEnvelope: { windowS: 0.25, rms: [0.1] } });
    expect(shouldAutoQueueCloudTranscribe({ ...baseClip, status: "analyzing", dossier })).toBe(
      false,
    );
  });

  it("is false without a dossier", () => {
    expect(shouldAutoQueueCloudTranscribe({ ...baseClip, status: "done", dossier: null })).toBe(
      false,
    );
  });

  it("is true for a done clip with audio and no cloudTranscript yet", () => {
    const dossier = fakeDossier({ audioEnvelope: { windowS: 0.25, rms: [0.1] } });
    expect(shouldAutoQueueCloudTranscribe({ ...baseClip, status: "done", dossier })).toBe(true);
  });

  it("is false when dossier.audioEnvelope is explicitly null (audio pass found no audio track)", () => {
    const dossier = fakeDossier({ audioEnvelope: null });
    expect(shouldAutoQueueCloudTranscribe({ ...baseClip, status: "done", dossier })).toBe(false);
  });

  it("is true when dossier.audioEnvelope is undefined — unknown is not the same as 'no audio'", () => {
    const dossier = fakeDossier(); // audioEnvelope left unset
    expect(dossier.audioEnvelope).toBeUndefined();
    expect(shouldAutoQueueCloudTranscribe({ ...baseClip, status: "done", dossier })).toBe(true);
  });

  it("is false once the dossier already carries a cloudTranscript", () => {
    const dossier = fakeDossier({
      audioEnvelope: { windowS: 0.25, rms: [0.1] },
      cloudTranscript: {
        model: "whisper-large-v3-turbo",
        segments: [],
        words: null,
        billedSeconds: 10,
        costUSD: 0.0001,
        ms: 100,
        transcribedAt: 1,
      },
    });
    expect(shouldAutoQueueCloudTranscribe({ ...baseClip, status: "done", dossier })).toBe(false);
  });

  it("is false once the clip has ANY cloud-transcribe attempt this session, even a failed one (no auto-retry)", () => {
    const dossier = fakeDossier({ audioEnvelope: { windowS: 0.25, rms: [0.1] } });
    expect(
      shouldAutoQueueCloudTranscribe({
        ...baseClip,
        status: "done",
        dossier,
        cloudTranscribe: { status: "error", error: "boom" },
      }),
    ).toBe(false);
  });
});
