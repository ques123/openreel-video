import { describe, expect, it } from "vitest";
import { buildFootageDigest } from "../footage-digest";
import { makeDossier, makeShot } from "./director-fixtures";

describe("buildFootageDigest", () => {
  it("returns an empty string for no clips", () => {
    expect(buildFootageDigest([])).toBe("");
  });

  it("emits a header and local-caption timeline for a single clip", () => {
    const dossier = makeDossier({
      fileName: "IMG_2041.mov",
      durationS: 74,
      shots: [makeShot(0, 0, 40), makeShot(1, 40, 74)],
      denseCaptions: [
        { t: 5, text: "people browsing a riverside market" },
        { t: 20, text: "people browsing a riverside market" },
        { t: 31, text: "people browsing a riverside market" },
      ],
    });
    const digest = buildFootageDigest([dossier]);
    expect(digest).toContain("Clip 1/1 — IMG_2041.mov (74s, 2 shots)");
    expect(digest).toContain("0:05–0:31 people browsing a riverside market");
  });

  it("prefers cloud dense captions over local ones for the timeline", () => {
    const dossier = makeDossier({
      denseCaptions: [{ t: 0, text: "a blurry local guess" }],
      cloudDenseCaptions: [{ t: 0, text: "a sharp cloud description" }],
    });
    const digest = buildFootageDigest([dossier]);
    expect(digest).toContain("a sharp cloud description");
    expect(digest).not.toContain("a blurry local guess");
  });

  it("adds distinctive cloud shot captions only when the timeline is local-only", () => {
    const localOnly = makeDossier({
      denseCaptions: [{ t: 0, text: "local scene" }],
      cloudShotCaptions: [
        { t: 1, text: "a dog runs across the beach" },
        { t: 2, text: "a dog runs across the beach" },
        { t: 3, text: "waves crash on the shore" },
      ],
    });
    const digest = buildFootageDigest([localOnly]);
    expect(digest).toContain("shot: a dog runs across the beach");
    expect(digest).toContain("shot: waves crash on the shore");
    // deduped exact-text repeat
    expect(digest.match(/a dog runs across the beach/g)?.length).toBe(1);

    const cloudTimeline = makeDossier({
      cloudDenseCaptions: [{ t: 0, text: "cloud timeline text" }],
      cloudShotCaptions: [{ t: 1, text: "should not appear" }],
    });
    expect(buildFootageDigest([cloudTimeline])).not.toContain("should not appear");
  });

  it("sorts by recordedAt, nulls last, then by fileName", () => {
    const b = makeDossier({ fileName: "b.mov", recordedAt: 2000 });
    const a = makeDossier({ fileName: "a.mov", recordedAt: 1000 });
    const noTimeZ = makeDossier({ fileName: "z-no-time.mov", recordedAt: null });
    const noTimeY = makeDossier({ fileName: "y-no-time.mov", recordedAt: null });
    const digest = buildFootageDigest([b, noTimeZ, a, noTimeY]);
    const order = ["a.mov", "b.mov", "y-no-time.mov", "z-no-time.mov"];
    const positions = order.map((name) => digest.indexOf(name));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
    expect(digest).toContain("Clip 1/4 — a.mov");
    expect(digest).toContain("Clip 2/4 — b.mov");
    expect(digest).toContain("Clip 3/4 — y-no-time.mov");
    expect(digest).toContain("Clip 4/4 — z-no-time.mov");
  });

  it("includes transcript lines and skips blank ones", () => {
    const dossier = makeDossier({
      transcript: [
        { t0: 12, t1: 14, text: "there is a blue bus!" },
        { t0: 20, t1: 21, text: "   " },
        { t0: 30, t1: 31, text: "" },
      ],
    });
    const digest = buildFootageDigest([dossier]);
    expect(digest).toContain('said @0:12: "there is a blue bus!"');
    // no line was generated for the blank/empty segments
    expect(digest.split("\n").filter((l) => l.includes("said @"))).toHaveLength(1);
  });

  it("prefers longer (more content-rich) utterances when trimming transcript lines", () => {
    const transcript = Array.from({ length: 8 }, (_, i) => ({
      t0: i * 10,
      t1: i * 10 + 2,
      text: i === 3 ? "this is by far the longest and most informative utterance here" : "ok",
    }));
    const digest = buildFootageDigest([makeDossier({ transcript })]);
    expect(digest).toContain("this is by far the longest and most informative utterance here");
  });

  it("marks clips with zero captions and zero transcript", () => {
    const dossier = makeDossier({ denseCaptions: [], cloudDenseCaptions: [], transcript: [] });
    const digest = buildFootageDigest([dossier]);
    expect(digest).toContain("(no captions yet)");
    expect(digest).not.toContain("said @");
  });

  it("respects the char budget while keeping every clip header", () => {
    const dossiers = Array.from({ length: 12 }, (_, i) =>
      makeDossier({
        fileName: `clip-${String(i).padStart(2, "0")}.mov`,
        durationS: 120,
        denseCaptions: Array.from({ length: 30 }, (_, j) => ({
          t: j * 4,
          text: `unique scene description number ${i}-${j} with plenty of distinguishing words`,
        })),
        transcript: Array.from({ length: 10 }, (_, j) => ({
          t0: j * 5,
          t1: j * 5 + 3,
          text: `a reasonably long spoken sentence number ${i}-${j} about the footage`,
        })),
      }),
    );
    const budget = 3000;
    const digest = buildFootageDigest(dossiers, { charBudget: budget });
    expect(digest.length).toBeLessThanOrEqual(budget);
    for (let i = 0; i < dossiers.length; i++) {
      expect(digest).toContain(`Clip ${i + 1}/12 — clip-${String(i).padStart(2, "0")}.mov`);
    }
  });

  it("is deterministic across calls", () => {
    const dossiers = [
      makeDossier({
        fileName: "a.mov",
        denseCaptions: [{ t: 0, text: "scene one" }],
        transcript: [{ t0: 1, t1: 2, text: "hello there" }],
      }),
      makeDossier({
        fileName: "b.mov",
        recordedAt: 500,
        cloudDenseCaptions: [{ t: 0, text: "cloud scene" }],
      }),
    ];
    const first = buildFootageDigest(dossiers);
    const second = buildFootageDigest(dossiers);
    expect(first).toBe(second);
  });
});
