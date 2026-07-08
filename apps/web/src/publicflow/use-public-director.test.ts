/**
 * Reducer-level coverage for the music pending lifecycle (types.ts's
 * musicPending) — the piece of use-public-director.ts that's pure and
 * exported for exactly this reason; the surrounding runLoop/runMusic async
 * plumbing isn't reasonably unit-testable without a much heavier harness, so
 * this file stays at the reducer.
 *
 * The real guard against a SUPERSEDED run's stale music-ready/music-settled
 * corrupting the NEW cut lives one layer up, in runMusic itself (onReady and
 * onSettle are both gated on `!signal.aborted`, and runLoop aborts the
 * previous musicController synchronously before a fresh run does anything
 * else — see runMusic's doc comment) — NOT here. This reducer has no concept
 * of which run an action came from, so a dispatch that reached it at all
 * merges into whatever cut is CURRENTLY in phase; the "does not distinguish"
 * test below documents that boundary rather than asserting a safety net that
 * doesn't exist at this level.
 */
import { describe, expect, it } from "vitest";
import type { DirectorPhase, PublicCut } from "./types";
import { reducer } from "./use-public-director";

function fixtureCut(overrides: Partial<PublicCut> = {}): PublicCut {
  return {
    title: "Golden Hour, Mostly",
    totalS: 30,
    segments: [],
    clipCount: 1,
    musicTakes: null,
    musicPending: true,
    ...overrides,
  };
}

describe("reducer — music-ready", () => {
  it("sets the takes and clears musicPending on the current done cut", () => {
    const phase: DirectorPhase = { kind: "done", cut: fixtureCut({ musicPending: true }) };
    const next = reducer(phase, { type: "music-ready", musicTakes: { a: "u-a", b: "u-b" } });
    expect(next).toEqual({
      kind: "done",
      cut: fixtureCut({ musicTakes: { a: "u-a", b: "u-b" }, musicPending: false }),
    });
  });

  it("is a no-op when phase isn't done (e.g. a new run has already moved on to running)", () => {
    const phase: DirectorPhase = { kind: "running", activity: [] };
    expect(reducer(phase, { type: "music-ready", musicTakes: { a: "u-a", b: "u-b" } })).toBe(phase);
  });

  it("does not distinguish which run a dispatch came from — merges into whatever cut is CURRENTLY in phase (staleness is prevented upstream; see this file's own header comment)", () => {
    const currentCut = fixtureCut({ title: "Current Cut", musicPending: true });
    const phase: DirectorPhase = { kind: "done", cut: currentCut };
    const next = reducer(phase, { type: "music-ready", musicTakes: { a: "a", b: "b" } });
    expect(next).toEqual({
      kind: "done",
      cut: { ...currentCut, musicTakes: { a: "a", b: "b" }, musicPending: false },
    });
  });
});

describe("reducer — music-settled", () => {
  it("clears musicPending without touching musicTakes", () => {
    const phase: DirectorPhase = { kind: "done", cut: fixtureCut({ musicPending: true, musicTakes: null }) };
    expect(reducer(phase, { type: "music-settled" })).toEqual({
      kind: "done",
      cut: fixtureCut({ musicPending: false, musicTakes: null }),
    });
  });

  it("preserves already-landed musicTakes (runMusic's `ready` flag should prevent a settle firing after a ready at all, but the reducer stays non-destructive either way)", () => {
    const phase: DirectorPhase = {
      kind: "done",
      cut: fixtureCut({ musicPending: false, musicTakes: { a: "a", b: "b" } }),
    };
    expect(reducer(phase, { type: "music-settled" })).toEqual({
      kind: "done",
      cut: fixtureCut({ musicPending: false, musicTakes: { a: "a", b: "b" } }),
    });
  });

  it("is a no-op when phase isn't done", () => {
    const idle: DirectorPhase = { kind: "idle" };
    expect(reducer(idle, { type: "music-settled" })).toBe(idle);

    const error: DirectorPhase = { kind: "error", code: "upstream_error", friendly: "x", retryable: true };
    expect(reducer(error, { type: "music-settled" })).toBe(error);

    const running: DirectorPhase = { kind: "running", activity: [] };
    expect(reducer(running, { type: "music-settled" })).toBe(running);
  });
});
