import { describe, expect, it } from "vitest";
import {
  MUSIC_LIMITS,
  buildMusicBriefFallback,
  clampMusicBrief,
  type MusicBrief,
} from "../music-prompt";
import type { Storyboard, StoryboardItem } from "../director-types";

function makeItem(role: string, why = "why"): StoryboardItem {
  return {
    clipId: "clip-a",
    fileName: "a.mp4",
    shotIndex: null,
    inS: 0,
    outS: 5,
    role,
    why,
    thumbnailDataUrl: null,
  };
}

describe("buildMusicBriefFallback", () => {
  it("falls back to cinematic travel/vlog defaults when input is thin", () => {
    const brief = buildMusicBriefFallback("", null, null);
    expect(brief.style).toMatch(/cinematic travel\/vlog/i);
    expect(brief.style).toMatch(/instrumental, no vocals/i);
    expect(brief.title).toBe("Background Score (score)");
    expect(brief.prompt).toMatch(/no vocals/i);
  });

  it("derives style and title from the user brief when no storyboard is given", () => {
    const brief = buildMusicBriefFallback(
      "A weekend trip through the mountains with old friends, lots of laughing",
      null,
      null,
    );
    expect(brief.style).toMatch(/weekend trip through the mountains/i);
    expect(brief.title).toBe("A weekend trip through the mountains (score)");
    expect(brief.style).toMatch(/instrumental, no vocals/i);
  });

  it("prefers the storyboard title over the brief for the title", () => {
    const storyboard: Storyboard = {
      title: "Durian Market Morning",
      notes: null,
      items: [makeItem("hook"), makeItem("context"), makeItem("payoff")],
    };
    const brief = buildMusicBriefFallback("a trip to the market", storyboard, 60);
    expect(brief.title).toBe("Durian Market Morning (score)");
    expect(brief.style).toMatch(/Durian Market Morning/);
  });

  it("reads hook/payoff pacing signals from storyboard item roles", () => {
    const withHookAndPayoff: Storyboard = {
      title: "Test",
      notes: null,
      items: [makeItem("hook"), makeItem("development"), makeItem("payoff")],
    };
    const b1 = buildMusicBriefFallback("brief", withHookAndPayoff, null);
    expect(b1.style).toMatch(/building tension.*payoff/i);
    expect(b1.prompt).toMatch(/building tension.*payoff/i);

    const hookOnly: Storyboard = {
      title: "Test",
      notes: null,
      items: [makeItem("hook"), makeItem("b-roll")],
    };
    const b2 = buildMusicBriefFallback("brief", hookOnly, null);
    expect(b2.style).toMatch(/attention-grabbing opening/i);

    const actionOnly: Storyboard = {
      title: "Test",
      notes: null,
      items: [makeItem("action"), makeItem("action")],
    };
    const b3 = buildMusicBriefFallback("brief", actionOnly, null);
    expect(b3.style).toMatch(/energetic momentum/i);

    const noSignal: Storyboard = { title: "Test", notes: null, items: [makeItem("b-roll")] };
    const b4 = buildMusicBriefFallback("brief", noSignal, null);
    expect(b4.style).toMatch(/even, unobtrusive pace/i);
  });

  it("folds storyboard notes and target duration into the style and prompt", () => {
    const storyboard: Storyboard = {
      title: "Rainy City Walk",
      notes: "melancholy but hopeful, rain-soaked streets",
      items: [makeItem("hook")],
    };
    const brief = buildMusicBriefFallback("a walk in the rain", storyboard, 42);
    expect(brief.style).toMatch(/melancholy but hopeful/i);
    expect(brief.style).toMatch(/42 seconds/);
    expect(brief.prompt).toMatch(/melancholy but hopeful/i);
    expect(brief.prompt).toMatch(/42 seconds/);
  });

  it("is deterministic for identical input", () => {
    const storyboard: Storyboard = {
      title: "Deterministic Test",
      notes: "steady, calm",
      items: [makeItem("hook"), makeItem("context"), makeItem("payoff")],
    };
    const a = buildMusicBriefFallback("same brief text", storyboard, 30);
    const b = buildMusicBriefFallback("same brief text", storyboard, 30);
    expect(a).toEqual(b);
  });

  it("always enforces MUSIC_LIMITS even on the raw heuristic output", () => {
    const longBrief = "word ".repeat(2000);
    const storyboard: Storyboard = {
      title: "T".repeat(200),
      notes: "note ".repeat(2000),
      items: [makeItem("hook"), makeItem("payoff")],
    };
    const brief = buildMusicBriefFallback(longBrief, storyboard, 90);
    expect(brief.style.length).toBeLessThanOrEqual(MUSIC_LIMITS.style);
    expect(brief.title.length).toBeLessThanOrEqual(MUSIC_LIMITS.title);
    expect(brief.prompt.length).toBeLessThanOrEqual(MUSIC_LIMITS.prompt);
  });
});

describe("clampMusicBrief", () => {
  it("leaves briefs under the limits unchanged", () => {
    const brief: MusicBrief = { style: "warm acoustic", title: "My Video (score)", prompt: "a short prompt" };
    expect(clampMusicBrief(brief)).toEqual(brief);
  });

  it("truncates each field on a word boundary at its own limit", () => {
    const brief: MusicBrief = {
      style: "a".repeat(MUSIC_LIMITS.style + 50),
      title: "b".repeat(MUSIC_LIMITS.title + 50),
      prompt: "c".repeat(MUSIC_LIMITS.prompt + 50),
    };
    const clamped = clampMusicBrief(brief);
    expect(clamped.style.length).toBeLessThanOrEqual(MUSIC_LIMITS.style);
    expect(clamped.title.length).toBeLessThanOrEqual(MUSIC_LIMITS.title);
    expect(clamped.prompt.length).toBeLessThanOrEqual(MUSIC_LIMITS.prompt);
  });

  it("cuts at a word boundary rather than mid-word", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const clamped = clampMusicBrief({ style: words, title: "t", prompt: "p" });
    expect(clamped.style.length).toBeLessThanOrEqual(MUSIC_LIMITS.style);
    // No trailing partial token: the clamped string, split on whitespace,
    // reassembled, must equal itself (i.e. it ends cleanly on a boundary).
    expect(clamped.style.endsWith(" ")).toBe(false);
    expect(words.startsWith(clamped.style)).toBe(true);
  });

  it("is idempotent", () => {
    const brief: MusicBrief = {
      style: "x".repeat(MUSIC_LIMITS.style + 20),
      title: "y".repeat(MUSIC_LIMITS.title + 20),
      prompt: "z".repeat(MUSIC_LIMITS.prompt + 20),
    };
    const once = clampMusicBrief(brief);
    const twice = clampMusicBrief(once);
    expect(twice).toEqual(once);
  });
});
