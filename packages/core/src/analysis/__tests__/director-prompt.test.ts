import { describe, expect, it } from "vitest";
import {
  buildBriefMessage,
  buildCandidatesMessage,
  buildDossierMessage,
  buildRefineMessage,
  dossierToPromptText,
  formatSearchResults,
  formatValidationFeedback,
} from "../director-prompt";
import type { SearchResult } from "../retrieval";
import type { Storyboard } from "../director-types";
import { DEFAULT_SELECTOR_CONFIG } from "../signal-score";
import type { SelectionResult } from "../signal-score";
import { makeChapter, makeDossier, makePick, makeShot, makeShotScore } from "./director-fixtures";

describe("dossierToPromptText", () => {
  it("renders header, shots table and rounds times to 0.1s", () => {
    const dossier = makeDossier({
      clipId: "clip-x",
      fileName: "DJI_0362.MP4",
      durationS: 154.333,
      shots: [makeShot(0, 0, 6.24999, { motion: 31.4, sharpness: 812.7 })],
    });
    const text = dossierToPromptText(dossier);
    expect(text).toContain('CLIP clip-x "DJI_0362.MP4"  duration 154.3s  1920x1080');
    expect(text).toContain("#0  0.0-6.2s  6.2s  motion 31 peak@3.1  sharp 813");
  });

  it("includes the PARTIAL warning only when analysis was partial", () => {
    expect(dossierToPromptText(makeDossier({ analyzedThroughS: null }))).not.toContain("PARTIAL");
    const partial = dossierToPromptText(makeDossier({ analyzedThroughS: 61 }));
    expect(partial).toContain("!! PARTIAL: analyzed only through 61.0s");
  });

  it("marks empty transcripts as no speech", () => {
    expect(dossierToPromptText(makeDossier({ transcript: [] }))).toContain(
      "TRANSCRIPT: (no speech detected)",
    );
  });

  it("truncates long transcripts at the character budget", () => {
    const transcript = Array.from({ length: 50 }, (_, i) => ({
      t0: i,
      t1: i + 1,
      text: "x".repeat(100),
    }));
    const text = dossierToPromptText(makeDossier({ transcript }), { maxTranscriptChars: 500 });
    expect(text).toContain("[transcript truncated]");
    expect(text).not.toContain(`[45.0-46.0]`);
  });

  it("includes scene descriptions when captioned, truncated at 240 chars", () => {
    const long = "a ".repeat(140).trim();
    const text = dossierToPromptText(
      makeDossier({
        shots: [
          makeShot(0, 0, 10, { caption: "a man cuts open a durian at a market stall" }),
          makeShot(1, 10, 25, { caption: long }),
        ],
      }),
    );
    expect(text).toContain('sharp 500  "a man cuts open a durian at a market stall"');
    expect(text).toContain('..."');
    expect(text).toContain("scene description");
  });

  it("the source mixer excludes what it is told to", () => {
    const dossier = makeDossier({
      shots: [
        makeShot(0, 0, 10, {
          caption: "local shot text",
          cloudCaption: "cloud shot text",
        }),
      ],
      denseCaptions: [{ t: 0, text: "local timeline text" }],
      cloudDenseCaptions: [{ t: 0, text: "cloud timeline text" }],
      transcript: [{ t0: 0, t1: 2, text: "spoken words" }],
    });

    const noCloud = dossierToPromptText(dossier, {
      sources: { localCaptions: true, cloudShots: false, cloudTimeline: false, transcript: true },
    });
    expect(noCloud).toContain("local shot text");
    expect(noCloud).not.toContain("cloud shot text");
    expect(noCloud).toContain("local timeline text");
    expect(noCloud).not.toContain("cloud timeline text");
    expect(noCloud).toContain("spoken words");

    const cloudOnly = dossierToPromptText(dossier, {
      sources: { localCaptions: false, cloudShots: true, cloudTimeline: true, transcript: false },
    });
    expect(cloudOnly).toContain("cloud shot text");
    expect(cloudOnly).not.toContain("local shot text");
    expect(cloudOnly).toContain("cloud timeline text");
    expect(cloudOnly).not.toContain("local timeline text");
    expect(cloudOnly).not.toContain("spoken words");
    expect(cloudOnly).toContain("withheld for this run");
  });

  it("model pins select the archived run instead of the latest", () => {
    const meta = (model: string) => ({
      model, enhancedAt: 1, framesSent: 1, framesFailed: 0, ms: 1, promptTokens: 1, completionTokens: 1,
    });
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 10, { cloudCaption: "latest shots text" })],
      cloudDenseCaptions: [{ t: 0, text: "latest timeline text" }],
      cloudRuns: { shots: meta("gpt-5.2"), timeline: meta("gpt-5.2") },
    });
    dossier.cloudRunArchive = [
      { scope: "timeline", model: "gpt-5.2", captions: [{ t: 0, text: "latest timeline text" }], meta: meta("gpt-5.2") },
      { scope: "timeline", model: "gpt-5.4-mini", captions: [{ t: 0, text: "mini timeline text" }], meta: meta("gpt-5.4-mini") },
      { scope: "shots", model: "gpt-5.4-mini", captions: [{ t: 5, text: "mini shots text" }], meta: meta("gpt-5.4-mini") },
    ];

    const pinned = dossierToPromptText(dossier, {
      sources: {
        localCaptions: false, cloudShots: true, cloudTimeline: true, transcript: false,
        cloudTimelineModel: "gpt-5.4-mini", cloudShotsModel: "gpt-5.4-mini",
      },
    });
    expect(pinned).toContain("mini timeline text");
    expect(pinned).not.toContain("latest timeline text");
    expect(pinned).toContain("CLOUD-ENHANCED by gpt-5.4-mini");
    expect(pinned).toContain("mini shots text");

    // Unpinned keeps the latest run; a pin to a missing model falls back.
    const unpinned = dossierToPromptText(dossier, {
      sources: { localCaptions: false, cloudShots: true, cloudTimeline: true, transcript: false },
    });
    expect(unpinned).toContain("latest timeline text");
    const missingPin = dossierToPromptText(dossier, {
      sources: {
        localCaptions: false, cloudShots: true, cloudTimeline: true, transcript: false,
        cloudTimelineModel: "gpt-9-nonexistent",
      },
    });
    expect(missingPin).toContain("latest timeline text");
  });

  it("prefers cloud captions and the cloud timeline when present", () => {
    const text = dossierToPromptText(
      makeDossier({
        shots: [
          makeShot(0, 0, 10, {
            caption: "a market",
            cloudCaption: "a vendor slices durian for waiting customers",
          }),
        ],
        denseCaptions: [{ t: 0, text: "local caption" }],
        cloudDenseCaptions: [{ t: 0, text: "cloud caption with real detail" }],
      }),
    );
    expect(text).toContain('"a vendor slices durian for waiting customers"');
    expect(text).not.toContain('"a market"');
    expect(text).toContain("CLOUD-ENHANCED");
    expect(text).toContain("cloud caption with real detail");
    expect(text).not.toContain("local caption");
  });

  it("renders a merged scene timeline from dense captions", () => {
    const text = dossierToPromptText(
      makeDossier({
        denseCaptions: [
          { t: 0, text: "road, trees and sky" },
          { t: 2, text: "road, trees and sky" },
          { t: 4, text: "a person at a market stall" },
        ],
      }),
    );
    expect(text).toContain("SCENE TIMELINE");
    expect(text).toContain("[0.0-2.0] road, trees and sky");
    expect(text).toContain("[4.0] a person at a market stall");
    expect(dossierToPromptText(makeDossier())).not.toContain("SCENE TIMELINE");
  });

  it("includes the recording time only when known", () => {
    expect(dossierToPromptText(makeDossier({ recordedAt: null }))).not.toContain("recorded");
    // 2026-06-24T05:42:00Z
    const text = dossierToPromptText(makeDossier({ recordedAt: 1782279720000 }));
    expect(text).toContain("recorded 2026-06-24 05:42 UTC");
  });
});

describe("buildDossierMessage / buildBriefMessage", () => {
  it("states the clip count", () => {
    const msg = buildDossierMessage([makeDossier(), makeDossier({ clipId: "clip-b" })]);
    expect(msg).toContain("FOOTAGE: 2 analyzed clips");
  });

  it("lists clips oldest-first, unknown recording times last", () => {
    const msg = buildDossierMessage([
      makeDossier({ clipId: "clip-late", recordedAt: 2000 }),
      makeDossier({ clipId: "clip-undated", recordedAt: null }),
      makeDossier({ clipId: "clip-early", recordedAt: 1000 }),
    ]);
    expect(msg).toContain("RECORDING ORDER");
    const order = ["clip-early", "clip-late", "clip-undated"].map((id) =>
      msg.indexOf(`CLIP ${id}`),
    );
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it("only mentions target duration when one is set", () => {
    expect(buildBriefMessage("energetic cut", null)).not.toContain("TARGET");
    expect(buildBriefMessage("energetic cut", 60)).toContain("TARGET DURATION: 60.0s");
  });
});

describe("formatSearchResults", () => {
  const hit = (score: number, confident: boolean): SearchResult["hits"][number] => ({
    clipId: "clip-a",
    fileName: "test.mp4",
    shot: makeShot(2, 25, 60),
    score,
    confident,
  });

  it("labels confident vs weak hits with shot coordinates", () => {
    const text = formatSearchResults("a dog", {
      hits: [hit(0.31, true), hit(0.19, false)],
      mean: 0.18,
      std: 0.03,
    });
    expect(text).toContain("CONFIDENT");
    expect(text).toContain("weak");
    expect(text).toContain("clip clip-a shot #2  25.0-60.0s");
  });

  it("calls out an all-weak result", () => {
    const text = formatSearchResults("snow", { hits: [hit(0.19, false)], mean: 0.18, std: 0.03 });
    expect(text).toContain("no confident hits");
  });
});

describe("feedback + refine messages", () => {
  it("lists errors and non-blocking warnings separately", () => {
    const text = formatValidationFeedback(["bad item"], ["clamped range"]);
    expect(text).toContain("REJECTED");
    expect(text).toContain("- bad item");
    expect(text).toContain("not blocking");
    expect(text).toContain("- clamped range");
  });

  it("embeds the current (possibly user-edited) storyboard", () => {
    const storyboard: Storyboard = {
      title: "Durian day",
      notes: null,
      items: [
        {
          clipId: "clip-a",
          fileName: "test.mp4",
          shotIndex: 1,
          inS: 10,
          outS: 14.55,
          role: "hook",
          why: "high motion",
          thumbnailDataUrl: null,
        },
      ],
    };
    const text = buildRefineMessage("less talking", storyboard);
    expect(text).toContain('"clipId": "clip-a"');
    expect(text).toContain('"out": 14.6');
    expect(text).toContain("total 4.6s");
    expect(text).toContain("USER FEEDBACK: less talking");
    expect(text).not.toContain("TARGET DURATION");
  });

  it("states the (possibly retuned) target on refine", () => {
    const storyboard: Storyboard = { title: null, notes: null, items: [] };
    expect(buildRefineMessage("shorter", storyboard, 12)).toContain(
      "TARGET DURATION is now 12.0s",
    );
  });
});

describe("buildCandidatesMessage", () => {
  // clip-b recorded earlier than clip-a; its lone ungated shot is the ch-0
  // pick. clip-a has a gated (blurry) shot and a picked, cloud-captioned,
  // speech-overlapping shot.
  const clipB = makeDossier({
    clipId: "clip-b",
    recordedAt: 1000,
    shots: [
      makeShot(0, 0, 8, { motion: 3, caption: "local b0" }),
      makeShot(1, 8, 16, { motion: 4, sharpness: 10, caption: "local b1" }),
    ],
  });
  const clipA = makeDossier({
    clipId: "clip-a",
    recordedAt: 2000,
    shots: [
      makeShot(0, 0, 10, { motion: 6, caption: "local a0" }),
      makeShot(1, 10, 20, {
        motion: 50,
        caption: "local a1",
        cloudCaption: "cloud a1",
      }),
    ],
    transcript: [{ t0: 11, t1: 14, text: "hello there" }],
  });

  function makeSelection(): SelectionResult {
    return {
      config: DEFAULT_SELECTOR_CONFIG,
      chapters: [
        makeChapter({ index: 0, clipIds: ["clip-b"], startedAt: 1000, label: "ch 0 · clip-b" }),
        makeChapter({ index: 1, clipIds: ["clip-a"], startedAt: 2000, label: "ch 1 · clip-a" }),
      ],
      scores: [
        makeShotScore({ clipId: "clip-b", shotIndex: 0, gated: false }),
        makeShotScore({
          clipId: "clip-b",
          shotIndex: 1,
          gated: true,
          gateReasons: ["blurry (sharpness 10 < 40)"],
        }),
        makeShotScore({ clipId: "clip-a", shotIndex: 0, gated: false }),
        makeShotScore({ clipId: "clip-a", shotIndex: 1, gated: false }),
      ],
      picks: [
        makePick({
          clipId: "clip-b",
          shotIndex: 0,
          chapterIndex: 0,
          rank: 1,
          finalScore: 0.61,
          uniquenessPenalty: 0,
          reasons: ["steady establishing shot"],
        }),
        makePick({
          clipId: "clip-a",
          shotIndex: 1,
          chapterIndex: 1,
          rank: 1,
          finalScore: 0.82,
          uniquenessPenalty: 0.12,
          reasons: ["high motion", "loud moment"],
        }),
      ],
    };
  }

  it("renders chapter headers, ranked picks with why-reasons and uniqueness penalty", () => {
    const text = buildCandidatesMessage([clipA, clipB], makeSelection());
    expect(text).toContain("FOOTAGE: 2 analyzed clips");
    expect(text).toContain("RECORDING ORDER");
    expect(text).toContain("HEURISTIC");
    expect(text).toContain("CHAPTER 0: ch 0 · clip-b");
    expect(text).toContain("CHAPTER 1: ch 1 · clip-a");
    expect(text).toContain("★C0.1");
    expect(text).toContain("why: steady establishing shot");
    expect(text).toContain("★C1.1");
    expect(text).toContain("why: high motion, loud moment");
    expect(text).toContain("(uniqueness −0.12)");
  });

  it("prefers the cloud caption on a pick and includes overlapping transcript lines", () => {
    const text = buildCandidatesMessage([clipA, clipB], makeSelection());
    expect(text).toContain('"cloud a1"');
    expect(text).not.toContain('"local a1"');
    expect(text).toContain("[11.0-14.0] hello there");
  });

  it("gist covers every non-picked shot and flags gated shots", () => {
    const text = buildCandidatesMessage([clipA, clipB], makeSelection());
    expect(text).toContain("ALL SHOTS (gist)");
    // clip-a shot #0 was never picked: appears in the gist, un-starred.
    expect(text).toContain('   #0  0.0-10.0s  motion 6 sharp 500  "local a0"');
    // clip-a shot #1 WAS picked: starred in the gist too.
    expect(text).toContain("★#1  10.0-20.0s");
    // clip-b shot #1 is gated (blurry) — flagged, not starred.
    expect(text).toContain("[gated: blurry (sharpness 10 < 40)]");
  });

  it("lists clips in recording order (clip-b before clip-a) in the gist and transcripts", () => {
    const text = buildCandidatesMessage([clipA, clipB], makeSelection());
    const gistB = text.indexOf('CLIP clip-b "test.mp4"');
    const gistA = text.indexOf('CLIP clip-a "test.mp4"');
    expect(gistB).toBeGreaterThan(-1);
    expect(gistA).toBeGreaterThan(gistB);
  });

  it("withholds transcripts for every clip when sources.transcript is false", () => {
    const text = buildCandidatesMessage([clipA, clipB], makeSelection(), {
      localCaptions: true,
      cloudShots: true,
      cloudTimeline: true,
      transcript: false,
    });
    expect(text).not.toContain("hello there");
    const withheldCount = text.split("withheld for this run").length - 1;
    expect(withheldCount).toBe(2);
  });
});
