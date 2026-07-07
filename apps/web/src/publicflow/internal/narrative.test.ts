import { describe, expect, it } from "vitest";
import type { DirectorActivity } from "@openreel/core";
import {
  ASSEMBLING_LINE,
  reduceDirectorActivity,
  reduceDirectorActivityLog,
} from "./narrative";

describe("reduceDirectorActivity", () => {
  it("round 1 of a fresh generate reads as 'reading through your footage'", () => {
    expect(reduceDirectorActivity({ kind: "round", round: 1 }, false)).toEqual({
      text: "reading through your footage",
      isQuery: false,
    });
  });

  it("round 1 of a refine reads as 'reviewing your notes' instead", () => {
    expect(reduceDirectorActivity({ kind: "round", round: 1 }, true)).toEqual({
      text: "reviewing your notes",
      isQuery: false,
    });
  });

  it("rounds after the first produce no line (avoids repeating engineering noise)", () => {
    expect(reduceDirectorActivity({ kind: "round", round: 2 }, false)).toBeNull();
    expect(reduceDirectorActivity({ kind: "round", round: 7 }, true)).toBeNull();
  });

  it("a search query surfaces verbatim, quoted, marked isQuery", () => {
    const activity: DirectorActivity = {
      kind: "search",
      query: "people laughing around a table at dusk",
      hitCount: 4,
      confidentCount: 2,
    };
    // Bare query — the renderer (DirectingScene) owns the "Looking for:"
    // label + quotes so it isn't double-applied in the UI.
    expect(reduceDirectorActivity(activity, false)).toEqual({
      text: "people laughing around a table at dusk",
      isQuery: true,
    });
  });

  it("a search query with special characters still passes through verbatim (no escaping/mangling)", () => {
    const activity: DirectorActivity = {
      kind: "search",
      query: 'a sign that says "no entry"',
      hitCount: 0,
      confidentCount: 0,
    };
    expect(reduceDirectorActivity(activity, false)?.text).toBe('a sign that says "no entry"');
  });

  it("a rejected submission becomes a generic line — raw validation errors never leak", () => {
    const activity: DirectorActivity = {
      kind: "rejected",
      errors: ['item 2: unknown clipId "abc" — known: clip-1, clip-2', "total duration 45.0s is over..."],
    };
    const line = reduceDirectorActivity(activity, false);
    expect(line).toEqual({ text: "double-checking the cut", isQuery: false });
    expect(line?.text).not.toContain("clipId");
    expect(line?.text).not.toContain("clip-1");
  });

  it("free-form model prose ('note') is dropped entirely — not part of the controlled narrative vocabulary", () => {
    expect(
      reduceDirectorActivity({ kind: "note", text: "I'll open with the sunset shot." }, false),
    ).toBeNull();
  });
});

describe("reduceDirectorActivityLog", () => {
  it("preserves order and drops nulls across a mixed log", () => {
    const log: DirectorActivity[] = [
      { kind: "round", round: 1 },
      { kind: "note", text: "thinking..." },
      { kind: "search", query: "a dog running on a beach", hitCount: 3, confidentCount: 1 },
      { kind: "round", round: 2 },
      { kind: "rejected", errors: ["bad thing"] },
      { kind: "round", round: 3 },
      { kind: "search", query: "sunset over water", hitCount: 5, confidentCount: 3 },
    ];
    expect(reduceDirectorActivityLog(log, false)).toEqual([
      { text: "reading through your footage", isQuery: false },
      { text: "a dog running on a beach", isQuery: true },
      { text: "double-checking the cut", isQuery: false },
      { text: "sunset over water", isQuery: true },
    ]);
  });

  it("returns [] for an empty log", () => {
    expect(reduceDirectorActivityLog([], false)).toEqual([]);
  });
});

describe("ASSEMBLING_LINE", () => {
  it("is the fixed, non-query narrative line appended once a storyboard is accepted", () => {
    expect(ASSEMBLING_LINE).toEqual({ text: "assembling your cut", isQuery: false });
  });
});
