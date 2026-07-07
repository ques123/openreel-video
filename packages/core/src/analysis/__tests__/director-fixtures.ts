import type { ClipDossier, CloudTranscriptMeta, DossierPerf, Shot, TranscriptSegment } from "../types";
import { DOSSIER_VERSION } from "../types";
import type { CandidatePick, Chapter, ShotScore } from "../signal-score";

export function makeShot(
  index: number,
  tStart: number,
  tEnd: number,
  opts: Partial<Pick<Shot, "thumbnailDataUrl" | "caption" | "cloudCaption" | "embedding">> & {
    motion?: number;
    sharpness?: number;
  } = {},
): Shot {
  return {
    index,
    tStart,
    tEnd,
    repFrameTime: (tStart + tEnd) / 2,
    thumbnailDataUrl: opts.thumbnailDataUrl ?? `thumb-${index}`,
    embedding: opts.embedding ?? null,
    frameEmbeddings: [],
    caption: opts.caption ?? null,
    cloudCaption: opts.cloudCaption ?? null,
    motion: { score: opts.motion ?? 10, peakTime: (tStart + tEnd) / 2 },
    quality: { sharpness: opts.sharpness ?? 500 },
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

export function makeDossier(
  opts: {
    clipId?: string;
    fileName?: string;
    recordedAt?: number | null;
    durationS?: number;
    analyzedThroughS?: number | null;
    shots?: Shot[];
    denseFrames?: { t: number; dataUrl: string; sharpness?: number }[];
    denseCaptions?: { t: number; text: string }[];
    cloudDenseCaptions?: { t: number; text: string }[];
    cloudShotCaptions?: { t: number; text: string }[];
    cloudRuns?: ClipDossier["cloudRuns"];
    cloudVision?: ClipDossier["cloudVision"];
    transcript?: TranscriptSegment[];
    cloudTranscript?: CloudTranscriptMeta | null;
  } = {},
): ClipDossier {
  return {
    version: DOSSIER_VERSION,
    clipId: opts.clipId ?? "clip-a",
    cacheKey: "perception:v4:test:0:0",
    fileName: opts.fileName ?? "test.mp4",
    recordedAt: opts.recordedAt ?? null,
    durationS: opts.durationS ?? 60,
    analyzedThroughS: opts.analyzedThroughS ?? null,
    width: 1920,
    height: 1080,
    shots: opts.shots ?? [makeShot(0, 0, 10), makeShot(1, 10, 25), makeShot(2, 25, 60)],
    denseFrames: opts.denseFrames ?? [],
    denseCaptions: opts.denseCaptions ?? [],
    cloudDenseCaptions: opts.cloudDenseCaptions ?? [],
    cloudShotCaptions: opts.cloudShotCaptions ?? [],
    cloudRuns: opts.cloudRuns ?? { shots: null, timeline: null },
    cloudRunArchive: [],
    cloudVision: opts.cloudVision ?? null,
    localCaptionPerf: null,
    transcript: opts.transcript ?? [],
    cloudTranscript: opts.cloudTranscript ?? null,
    perf,
  };
}

/** Cloud transcription run fixture (Groq whisper-large-v3-turbo by default). */
export function makeCloudTranscript(overrides: Partial<CloudTranscriptMeta> = {}): CloudTranscriptMeta {
  return {
    model: "whisper-large-v3-turbo",
    segments: [],
    words: null,
    billedSeconds: 10,
    costUSD: 0.0011,
    ms: 420,
    transcribedAt: 1,
    ...overrides,
  };
}

/**
 * Hand-built SelectionResult pieces for buildCandidatesMessage /
 * cloud-vision-plan tests — signal-score.ts's scoring/selection functions
 * are still stubs, so tests construct these directly rather than calling
 * selectCandidates.
 */
export function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    index: 0,
    clipIds: ["clip-a"],
    startedAt: null,
    label: "ch 0",
    ...overrides,
  };
}

export function makeShotScore(overrides: Partial<ShotScore> = {}): ShotScore {
  return {
    clipId: "clip-a",
    fileName: "test.mp4",
    shotIndex: 0,
    gated: false,
    gateReasons: [],
    components: { motion: 0, audio: 0, speech: 0, aesthetic: 0 },
    score: 0,
    ...overrides,
  };
}

export function makePick(overrides: Partial<CandidatePick> = {}): CandidatePick {
  return {
    clipId: "clip-a",
    fileName: "test.mp4",
    shotIndex: 0,
    chapterIndex: 0,
    rank: 1,
    finalScore: 0.5,
    uniquenessPenalty: 0,
    reasons: ["reason"],
    ...overrides,
  };
}
