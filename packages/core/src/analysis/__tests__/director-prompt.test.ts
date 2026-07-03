import { describe, expect, it } from "vitest";
import {
  buildBriefMessage,
  buildDossierMessage,
  buildRefineMessage,
  dossierToPromptText,
  formatSearchResults,
  formatValidationFeedback,
} from "../director-prompt";
import type { SearchResult } from "../retrieval";
import type { Storyboard } from "../director-types";
import { makeDossier, makeShot } from "./director-fixtures";

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
