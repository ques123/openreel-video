import type { ClipDossier, DossierPerf, Shot, TranscriptSegment } from "../types";
import { DOSSIER_VERSION } from "../types";

export function makeShot(
  index: number,
  tStart: number,
  tEnd: number,
  opts: Partial<Pick<Shot, "thumbnailDataUrl" | "caption" | "cloudCaption">> & {
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
    embedding: null,
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
    perf,
  };
}
