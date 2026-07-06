/**
 * Reducer-level tests for the event mappings added by the fleet-rollup /
 * cancel work: a deliberate cancelClip() lands the clip in a distinct
 * "cancelled" status (not "error"), a real failure still lands in "error"
 * with its message, and a "cache-invalidated" event flags staleReanalysis.
 * `reducer` and `initialState` are pure (no React) and exported from
 * use-perception-lab.ts specifically so this needs no DOM/render harness.
 */

import { describe, expect, it } from "vitest";
import type { FunnelProgressEvent } from "@openreel/core";
import { initialState, reducer, type LabState } from "./use-perception-lab";

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
