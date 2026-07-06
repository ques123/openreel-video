import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELECTOR_CONFIG,
  pickShot,
  picksForClip,
  scoreShots,
  segmentChapters,
  selectCandidates,
  type SelectorConfig,
} from "../signal-score";
import {
  DOSSIER_VERSION,
  type AudioEvent,
  type ClipDossier,
  type DossierPerf,
  type Shot,
  type TranscriptSegment,
} from "../types";

// ---------------------------------------------------------------------------
// local fixtures (do not import director-fixtures.ts — owned by another
// builder and mid-edit)
// ---------------------------------------------------------------------------

function l2norm(v: number[]): Float32Array {
  const arr = Float32Array.from(v);
  let sumSq = 0;
  for (const x of arr) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm > 0) for (let i = 0; i < arr.length; i += 1) arr[i] /= norm;
  return arr;
}

function makeShot(
  index: number,
  tStart: number,
  tEnd: number,
  opts: { motion?: number; sharpness?: number; embedding?: Float32Array | null } = {},
): Shot {
  return {
    index,
    tStart,
    tEnd,
    repFrameTime: (tStart + tEnd) / 2,
    thumbnailDataUrl: `thumb-${index}`,
    embedding: opts.embedding ?? null,
    frameEmbeddings: [],
    motion: { score: opts.motion ?? 10, peakTime: (tStart + tEnd) / 2 },
    quality: { sharpness: opts.sharpness ?? 500 },
    caption: null,
    cloudCaption: null,
  };
}

const perf: DossierPerf = {
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
};

function makeDossier(opts: {
  clipId?: string;
  fileName?: string;
  recordedAt?: number | null;
  durationS?: number;
  shots?: Shot[];
  transcript?: TranscriptSegment[];
  audioEvents?: AudioEvent[];
} = {}): ClipDossier {
  const shots = opts.shots ?? [makeShot(0, 0, 10)];
  return {
    version: DOSSIER_VERSION,
    clipId: opts.clipId ?? "clip-a",
    cacheKey: "perception:v4:test:0:0",
    fileName: opts.fileName ?? "test.mp4",
    recordedAt: opts.recordedAt ?? null,
    durationS: opts.durationS ?? shots[shots.length - 1]?.tEnd ?? 60,
    analyzedThroughS: null,
    width: 1920,
    height: 1080,
    shots,
    denseFrames: [],
    denseCaptions: [],
    cloudDenseCaptions: [],
    cloudShotCaptions: [],
    cloudRuns: { shots: null, timeline: null },
    cloudRunArchive: [],
    cloudVision: null,
    localCaptionPerf: null,
    transcript: opts.transcript ?? [],
    audioEvents: opts.audioEvents,
    perf,
  };
}

const NO_GATE: SelectorConfig = {
  ...DEFAULT_SELECTOR_CONFIG,
  gate: { minSharpness: 0, minShotS: 0 },
};

// ---------------------------------------------------------------------------
// segmentChapters
// ---------------------------------------------------------------------------

describe("segmentChapters", () => {
  it("returns [] for empty input", () => {
    expect(segmentChapters([])).toEqual([]);
  });

  it("a single clip forms one chapter with a single time label", () => {
    const t0 = Date.UTC(1970, 0, 1, 0, 0);
    const chapters = segmentChapters([makeDossier({ clipId: "only", recordedAt: t0 })]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({
      index: 0,
      clipIds: ["only"],
      startedAt: t0,
      label: "ch 1 · 00:00 UTC · 1 clip",
    });
  });

  it("splits chapters on a gap beyond chapterGapMinutes, sorting by recordedAt regardless of input order", () => {
    const t0 = 0;
    const t1 = t0 + 10 * 60_000; // 10 min later, within default 25-min gap
    const t2 = t1 + 30 * 60_000; // 30 min later, beyond the gap

    const chapters = segmentChapters([
      makeDossier({ clipId: "c3", recordedAt: t2 }),
      makeDossier({ clipId: "c1", recordedAt: t0 }),
      makeDossier({ clipId: "c2", recordedAt: t1 }),
    ]);

    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      index: 0,
      clipIds: ["c1", "c2"],
      startedAt: t0,
      label: "ch 1 · 00:00–00:10 UTC · 2 clips",
    });
    expect(chapters[1]).toMatchObject({
      index: 1,
      clipIds: ["c3"],
      startedAt: t2,
      label: "ch 2 · 00:40 UTC · 1 clip",
    });
  });

  it("does not split on a gap at or under the threshold", () => {
    const t0 = 0;
    const t1 = t0 + 25 * 60_000; // exactly the default threshold: not > it
    const chapters = segmentChapters([
      makeDossier({ clipId: "a", recordedAt: t0 }),
      makeDossier({ clipId: "b", recordedAt: t1 }),
    ]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].clipIds).toEqual(["a", "b"]);
  });

  it("all null-recordedAt clips form a single trailing 'unknown time' chapter", () => {
    const chapters = segmentChapters([
      makeDossier({ clipId: "a", recordedAt: null }),
      makeDossier({ clipId: "b", recordedAt: null }),
    ]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({
      index: 0,
      clipIds: ["a", "b"],
      startedAt: null,
      label: "ch 1 · unknown time · 2 clips",
    });
  });

  it("null-recordedAt clips trail after timed chapters, in their own chapter", () => {
    const t0 = 0;
    const t1 = t0 + 5 * 60_000;
    const chapters = segmentChapters([
      makeDossier({ clipId: "a", recordedAt: t0 }),
      makeDossier({ clipId: "x", recordedAt: null }),
      makeDossier({ clipId: "b", recordedAt: t1 }),
    ]);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].clipIds).toEqual(["a", "b"]);
    expect(chapters[1]).toMatchObject({ index: 1, clipIds: ["x"], startedAt: null });
  });
});

// ---------------------------------------------------------------------------
// scoreShots — gating
// ---------------------------------------------------------------------------

describe("scoreShots gating", () => {
  it("gates a blurry shot with a rounded sharpness reason", () => {
    const dossier = makeDossier({ shots: [makeShot(0, 0, 10, { sharpness: 12.4 })] });
    const [score] = scoreShots([dossier]);
    expect(score.gated).toBe(true);
    expect(score.gateReasons).toEqual(["blurry (sharpness 12 < 40)"]);
  });

  it("gates a too-short shot with a duration reason", () => {
    const dossier = makeDossier({ shots: [makeShot(0, 0, 0.5, { sharpness: 500 })] });
    const [score] = scoreShots([dossier]);
    expect(score.gated).toBe(true);
    expect(score.gateReasons).toEqual(["too short (0.5s < 0.8s)"]);
  });

  it("records both reasons when a shot fails both gates", () => {
    const dossier = makeDossier({ shots: [makeShot(0, 0, 0.3, { sharpness: 10 })] });
    const [score] = scoreShots([dossier]);
    expect(score.gated).toBe(true);
    expect(score.gateReasons).toHaveLength(2);
    expect(score.gateReasons[0]).toMatch(/blurry/);
    expect(score.gateReasons[1]).toMatch(/too short/);
  });

  it("leaves a passing shot ungated with no reasons, but still scored", () => {
    const dossier = makeDossier({ shots: [makeShot(0, 0, 10, { sharpness: 500, motion: 50 })] });
    const [score] = scoreShots([dossier]);
    expect(score.gated).toBe(false);
    expect(score.gateReasons).toEqual([]);
    expect(score.components.motion).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// scoreShots — normalization
// ---------------------------------------------------------------------------

describe("scoreShots normalization", () => {
  it("a single huge motion outlier does not crush the rest of the set toward 0", () => {
    // 19 ordinary shots at motion=10, one wild outlier at motion=500.
    const ordinary = Array.from({ length: 19 }, (_, i) => makeShot(i, i * 10, i * 10 + 5, { motion: 10 }));
    const outlier = makeShot(19, 300, 305, { motion: 500 });
    const dossier = makeDossier({ shots: [...ordinary, outlier] });

    const scores = scoreShots([dossier]);
    const ordinaryScores = scores.slice(0, 19);
    // p95 (nearest-rank, floor) lands on an ordinary value, not the outlier,
    // so ordinary shots normalize to 1, not ~10/500 = 0.02.
    for (const s of ordinaryScores) {
      expect(s.components.motion).toBeCloseTo(1, 5);
    }
    // The outlier itself still clamps to 1 (it's >= its own normalizer).
    expect(scores[19].components.motion).toBe(1);
  });

  it("aesthetic (sharpness) normalization is likewise outlier-resistant", () => {
    const ordinary = Array.from({ length: 19 }, (_, i) =>
      makeShot(i, i * 10, i * 10 + 5, { sharpness: 200 }),
    );
    const outlier = makeShot(19, 300, 305, { sharpness: 9000 });
    const dossier = makeDossier({ shots: [...ordinary, outlier] });

    const scores = scoreShots([dossier]);
    for (const s of scores.slice(0, 19)) {
      expect(s.components.aesthetic).toBeCloseTo(1, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreShots — audio component
// ---------------------------------------------------------------------------

describe("scoreShots audio component", () => {
  it("is 0 when the dossier has no audioEvents", () => {
    const dossier = makeDossier({ shots: [makeShot(0, 0, 10)] });
    const [score] = scoreShots([dossier]);
    expect(score.components.audio).toBe(0);
  });

  it("is 0 when audioEvents is an empty array", () => {
    const dossier = makeDossier({ shots: [makeShot(0, 0, 10)], audioEvents: [] });
    const [score] = scoreShots([dossier]);
    expect(score.components.audio).toBe(0);
  });

  it("scales by intensity (normalized by set p95) and by overlap duration", () => {
    // Clip A: event fully overlaps the shot (>= 1s overlap) -> full scale.
    const clipA = makeDossier({
      clipId: "a",
      shots: [makeShot(0, 0, 10)],
      audioEvents: [{ t: 2, durS: 3, intensity: 6 }],
    });
    // Clip B: same intensity, but only 0.2s of overlap -> scaled down.
    const clipB = makeDossier({
      clipId: "b",
      shots: [makeShot(0, 0, 10)],
      audioEvents: [{ t: 9.8, durS: 0.5, intensity: 6 }],
    });

    const scores = scoreShots([clipA, clipB]);
    const scoreA = scores.find((s) => s.clipId === "a")!;
    const scoreB = scores.find((s) => s.clipId === "b")!;

    expect(scoreA.components.audio).toBeCloseTo(1, 5);
    expect(scoreB.components.audio).toBeCloseTo(0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreShots — speech component
// ---------------------------------------------------------------------------

describe("scoreShots speech component", () => {
  it("is the fraction of the shot covered by transcript segments", () => {
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 10)],
      transcript: [{ t0: 2, t1: 6, text: "just narrating the scene" }],
    });
    const [score] = scoreShots([dossier]);
    expect(score.components.speech).toBeCloseTo(0.4, 5);
  });

  it("caps coverage at 1 even with overlapping/redundant segments", () => {
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 10)],
      transcript: [
        { t0: 0, t1: 10, text: "a" },
        { t0: 0, t1: 10, text: "b" },
      ],
    });
    const [score] = scoreShots([dossier]);
    expect(score.components.speech).toBe(1);
  });

  it("boosts speech to 1 when an overlapping segment contains a keyword (case-insensitive)", () => {
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 10)],
      transcript: [{ t0: 2, t1: 3, text: "and it was the winning GOAL of the match" }],
    });
    const config: SelectorConfig = { ...DEFAULT_SELECTOR_CONFIG, keywords: ["goal"] };
    const [score] = scoreShots([dossier], config);
    expect(score.components.speech).toBe(1);
  });

  it("does not boost when the keyword only appears in a non-overlapping segment", () => {
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 10)],
      transcript: [{ t0: 20, t1: 21, text: "goal!" }],
    });
    const config: SelectorConfig = { ...DEFAULT_SELECTOR_CONFIG, keywords: ["goal"] };
    const [score] = scoreShots([dossier], config);
    expect(score.components.speech).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// selectCandidates
// ---------------------------------------------------------------------------

describe("selectCandidates", () => {
  it("respects topPerChapter", () => {
    const shots = Array.from({ length: 5 }, (_, i) =>
      makeShot(i, i * 10, i * 10 + 5, { motion: 10 + i, embedding: l2norm([i + 1, 0]) }),
    );
    const dossier = makeDossier({ shots });
    const config: SelectorConfig = { ...NO_GATE, topPerChapter: 2, uniquenessPenalty: 0 };
    const result = selectCandidates([dossier], config);
    const picks = picksForClip(result, dossier.clipId);
    expect(picks).toHaveLength(2);
  });

  it("picks fewer than topPerChapter when fewer ungated shots exist", () => {
    const shots = [
      makeShot(0, 0, 10, { motion: 50, sharpness: 500 }), // ungated
      makeShot(1, 10, 10.3, { motion: 60, sharpness: 500 }), // too short -> gated
      makeShot(2, 20, 30, { motion: 40, sharpness: 5 }), // blurry -> gated
    ];
    const dossier = makeDossier({ shots });
    const config: SelectorConfig = { ...DEFAULT_SELECTOR_CONFIG, topPerChapter: 5 };
    const result = selectCandidates([dossier], config);
    const picks = picksForClip(result, dossier.clipId);
    expect(picks).toHaveLength(1);
    expect(picks[0].shotIndex).toBe(0);
  });

  it("the uniqueness penalty diversifies picks: a near-duplicate loses to a distinct, lower-scoring shot", () => {
    // Three shots, one chapter (single dossier). Motion-only scoring keeps
    // the math legible: p95 (nearest-rank floor over 3 values) lands on the
    // middle value (85), so A and B both clamp to composite 1, C is 0.941.
    const shots = [
      makeShot(0, 0, 10, { motion: 90, embedding: l2norm([1, 0]) }), // A
      makeShot(1, 10, 20, { motion: 85, embedding: l2norm([0.99, 0.14]) }), // B: near-dup of A
      makeShot(2, 20, 30, { motion: 80, embedding: l2norm([0, 1]) }), // C: distinct from A
    ];
    const dossier = makeDossier({ shots });
    const config: SelectorConfig = {
      ...NO_GATE,
      weights: { motion: 1, audio: 0, speech: 0, aesthetic: 0 },
      topPerChapter: 2,
      uniquenessPenalty: 0.35,
    };

    const result = selectCandidates([dossier], config);
    const picks = picksForClip(result, dossier.clipId);

    expect(picks).toHaveLength(2);
    // A (shotIndex 0) wins the first pick (tie with B broken by lower shotIndex).
    expect(picks[0].shotIndex).toBe(0);
    // C (shotIndex 2), not the near-duplicate B, wins the second pick because
    // B's high cosine similarity to the already-picked A drags its final
    // score below C's despite C's lower raw composite.
    expect(picks[1].shotIndex).toBe(2);
    expect(picks[1].uniquenessPenalty).toBeCloseTo(0, 5);
  });

  it("subtracts a real uniqueness penalty from finalScore for a near-duplicate that IS picked", () => {
    // Same set, but topPerChapter=1 per pick-scan check isn't useful; instead
    // verify the penalty value directly by picking with a config that forces
    // B to be picked second (raise topPerChapter, but B loses to C above) —
    // so instead check the penalty on a two-shot, all-similar case.
    const shots = [
      makeShot(0, 0, 10, { motion: 90, embedding: l2norm([1, 0]) }),
      makeShot(1, 10, 20, { motion: 85, embedding: l2norm([0.99, 0.14]) }),
    ];
    const dossier = makeDossier({ shots });
    const config: SelectorConfig = {
      ...NO_GATE,
      weights: { motion: 1, audio: 0, speech: 0, aesthetic: 0 },
      topPerChapter: 2,
      uniquenessPenalty: 0.35,
    };
    const result = selectCandidates([dossier], config);
    const picks = picksForClip(result, dossier.clipId);
    expect(picks).toHaveLength(2);
    expect(picks[0].uniquenessPenalty).toBe(0);
    // second pick's penalty ~= 0.35 * cos(A, B) ~= 0.35 * 0.99
    expect(picks[1].uniquenessPenalty).toBeCloseTo(0.35 * 0.99015, 3);
  });

  it("shots with a null embedding get no uniqueness penalty", () => {
    const shots = [
      makeShot(0, 0, 10, { motion: 90, embedding: l2norm([1, 0]) }),
      makeShot(1, 10, 20, { motion: 85, embedding: null }),
    ];
    const dossier = makeDossier({ shots });
    const config: SelectorConfig = {
      ...NO_GATE,
      weights: { motion: 1, audio: 0, speech: 0, aesthetic: 0 },
      topPerChapter: 2,
      uniquenessPenalty: 0.35,
    };
    const result = selectCandidates([dossier], config);
    const picks = picksForClip(result, dossier.clipId);
    const second = picks.find((p) => p.shotIndex === 1)!;
    expect(second.uniquenessPenalty).toBe(0);
  });

  it("produces at least one reason per pick, and a motion-dominant pick says so", () => {
    const dossier = makeDossier({
      shots: [makeShot(0, 0, 10, { motion: 90, sharpness: 500 })],
    });
    const config: SelectorConfig = {
      ...NO_GATE,
      weights: { motion: 1, audio: 0, speech: 0, aesthetic: 0 },
    };
    const result = selectCandidates([dossier], config);
    const picks = picksForClip(result, dossier.clipId);
    expect(picks[0].reasons.length).toBeGreaterThan(0);
    expect(picks[0].reasons[0]).toMatch(/high motion \(90\)/);
  });
});

// ---------------------------------------------------------------------------
// picksForClip / pickShot
// ---------------------------------------------------------------------------

describe("picksForClip", () => {
  it("filters by clipId and sorts by shotIndex", () => {
    const dossierA = makeDossier({
      clipId: "a",
      shots: [
        makeShot(0, 0, 10, { motion: 90 }),
        makeShot(1, 10, 20, { motion: 80 }),
      ],
    });
    const dossierB = makeDossier({ clipId: "b", shots: [makeShot(0, 0, 10, { motion: 70 })] });
    const config: SelectorConfig = { ...NO_GATE, topPerChapter: 10, uniquenessPenalty: 0 };
    const result = selectCandidates([dossierA, dossierB], config);

    const picksA = picksForClip(result, "a");
    expect(picksA.map((p) => p.shotIndex)).toEqual([0, 1]);
    expect(picksA.every((p) => p.clipId === "a")).toBe(true);
  });

  it("returns [] for a clipId with no picks", () => {
    const dossier = makeDossier({ shots: [makeShot(0, 0, 10)] });
    const result = selectCandidates([dossier]);
    expect(picksForClip(result, "nonexistent")).toEqual([]);
  });
});

describe("pickShot", () => {
  it("returns the referenced shot", () => {
    const shot = makeShot(1, 10, 20);
    const dossier = makeDossier({ clipId: "a", shots: [makeShot(0, 0, 10), shot] });
    const pick = {
      clipId: "a",
      fileName: "test.mp4",
      shotIndex: 1,
      chapterIndex: 0,
      rank: 1,
      finalScore: 1,
      uniquenessPenalty: 0,
      reasons: ["x"],
    };
    expect(pickShot([dossier], pick)).toBe(shot);
  });

  it("returns null when the dossier is missing", () => {
    const pick = {
      clipId: "missing",
      fileName: "test.mp4",
      shotIndex: 0,
      chapterIndex: 0,
      rank: 1,
      finalScore: 1,
      uniquenessPenalty: 0,
      reasons: [],
    };
    expect(pickShot([], pick)).toBeNull();
  });

  it("returns null when the shotIndex is out of range", () => {
    const dossier = makeDossier({ clipId: "a", shots: [makeShot(0, 0, 10)] });
    const pick = {
      clipId: "a",
      fileName: "test.mp4",
      shotIndex: 99,
      chapterIndex: 0,
      rank: 1,
      finalScore: 1,
      uniquenessPenalty: 0,
      reasons: [],
    };
    expect(pickShot([dossier], pick)).toBeNull();
  });
});
