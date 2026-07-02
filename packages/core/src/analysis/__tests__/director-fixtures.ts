import type { ClipDossier, DossierPerf, Shot, TranscriptSegment } from "../types";
import { DOSSIER_VERSION } from "../types";

export function makeShot(
  index: number,
  tStart: number,
  tEnd: number,
  opts: Partial<Pick<Shot, "thumbnailDataUrl">> & { motion?: number; sharpness?: number } = {},
): Shot {
  return {
    index,
    tStart,
    tEnd,
    repFrameTime: (tStart + tEnd) / 2,
    thumbnailDataUrl: opts.thumbnailDataUrl ?? `thumb-${index}`,
    embedding: null,
    frameEmbeddings: [],
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
    durationS?: number;
    analyzedThroughS?: number | null;
    shots?: Shot[];
    transcript?: TranscriptSegment[];
  } = {},
): ClipDossier {
  return {
    version: DOSSIER_VERSION,
    clipId: opts.clipId ?? "clip-a",
    cacheKey: "perception:v2:test:0:0",
    fileName: opts.fileName ?? "test.mp4",
    durationS: opts.durationS ?? 60,
    analyzedThroughS: opts.analyzedThroughS ?? null,
    width: 1920,
    height: 1080,
    shots: opts.shots ?? [makeShot(0, 0, 10), makeShot(1, 10, 25), makeShot(2, 25, 60)],
    transcript: opts.transcript ?? [],
    perf,
  };
}
