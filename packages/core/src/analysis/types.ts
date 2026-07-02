/**
 * Perception funnel types.
 *
 * A ClipDossier is the cached, fully-local analysis of one media file:
 * shot boundaries, per-shot motion/quality metrics, a representative frame
 * per shot with a CLIP embedding, and a timecoded transcript.
 */

export interface ShotMotion {
  /** Mean luma frame-diff magnitude within the shot (0..255 scale, typically < 40). */
  score: number;
  /** Timestamp (seconds) of the maximum frame diff within the shot. */
  peakTime: number;
}

export interface ShotQuality {
  /** Laplacian variance of the representative frame's grayscale plane. Higher = sharper. */
  sharpness: number;
}

export interface Shot {
  index: number;
  /** Shot start, seconds. */
  tStart: number;
  /** Shot end, seconds. */
  tEnd: number;
  /** Timestamp of the representative frame, seconds. */
  repFrameTime: number;
  /** Small JPEG data URL (~256px wide) of the representative frame. */
  thumbnailDataUrl: string;
  /** 512-d L2-normalized CLIP embedding of the representative frame. Null until embedded. */
  embedding: Float32Array | null;
  /**
   * Embeddings of several frames sampled across the shot (rep frame first).
   * Long shots contain more than one thing — retrieval scores a shot by its
   * BEST-matching frame, so content away from the rep frame stays findable.
   */
  frameEmbeddings: Float32Array[];
  motion: ShotMotion;
  quality: ShotQuality;
  /**
   * Machine-written scene description of the representative frame (local
   * Florence-2 pass). Null until the caption pass reaches this shot. Good for
   * scene gist; may miss small objects or assert details wrongly.
   */
  caption: string | null;
}

/** One timestamped machine scene description from the dense caption pass. */
export interface DenseCaption {
  /** Media time of the described frame, seconds. */
  t: number;
  text: string;
}

export interface TranscriptSegment {
  t0: number;
  t1: number;
  text: string;
}

export type InferenceDevice = "webgpu" | "wasm";

export interface DossierPerf {
  /** One-time stream-copy into OPFS scratch (0 when blob fallback was used). */
  ingestMs: number;
  /** True when analysis read from OPFS scratch instead of the dropped File. */
  usedOpfs: boolean;
  decodeMs: number;
  framesDecoded: number;
  /** Sampled frames analyzed per wall-second. */
  analysisFps: number;
  /** Source seconds analyzed per wall-second (realtime factor of the visual pass). */
  realtimeFactor: number;
  embedMs: number;
  embedPerFrameMs: number;
  audioDecodeMs: number;
  whisperMs: number;
  /** Realtime factor of the whisper pass (source seconds / wall seconds). */
  whisperRealtimeFactor: number;
  modelLoadMs: { clip: number; whisper: number };
  totalMs: number;
  device: { embed: InferenceDevice | null; whisper: InferenceDevice | null };
  cacheHit: boolean;
}

export interface ClipDossier {
  version: typeof DOSSIER_VERSION;
  /** Per-drop-session id (uuid). */
  clipId: string;
  /** Stable cache key: perception:v1:${name}:${size}:${lastModified}. */
  cacheKey: string;
  fileName: string;
  /**
   * When the clip was recorded (epoch ms), from the file's mtime — for camera
   * files that is the moment recording STOPPED. Null when unknown. Used by
   * the director to keep cuts in narrative (chronological) order.
   */
  recordedAt: number | null;
  durationS: number;
  /** Non-null when storage quota forced a partial analysis: shots/transcript cover [0, this]. */
  analyzedThroughS: number | null;
  width: number;
  height: number;
  shots: Shot[];
  /**
   * Timestamped scene descriptions every ~2s of footage (Florence over frames
   * sampled during decode). Far denser than shots — this is how the director
   * "watches" long takes. Grows in the background after analysis.
   */
  denseCaptions: DenseCaption[];
  transcript: TranscriptSegment[];
  perf: DossierPerf;
}

/** Raw RGBA pixels of a representative frame, transferred worker -> main -> embed worker. */
export interface RepFramePixels {
  data: ArrayBuffer;
  width: number;
  height: number;
}

/** Progress events surfaced to the UI by the orchestrator. */
export type FunnelProgressEvent =
  | {
      kind: "meta";
      clipId: string;
      durationS: number;
      width: number;
      height: number;
      analyzedThroughS: number | null;
    }
  | { kind: "ingest-progress"; clipId: string; bytesDone: number; bytesTotal: number }
  | { kind: "decode-progress"; clipId: string; t: number; framesDone: number }
  | {
      kind: "shot";
      clipId: string;
      shot: Shot;
    }
  | { kind: "shot-embedded"; clipId: string; shotIndex: number }
  | { kind: "shot-captioned"; clipId: string; shotIndex: number; caption: string }
  | { kind: "dense-captions"; clipId: string; done: number; total: number }
  | { kind: "transcript"; clipId: string; segments: TranscriptSegment[] }
  | {
      kind: "model-progress";
      model: "clip" | "whisper" | "florence";
      file: string;
      loaded: number;
      total: number;
    }
  | {
      kind: "model-ready";
      model: "clip" | "whisper" | "florence";
      device: InferenceDevice;
      loadMs: number;
    }
  | { kind: "clip-done"; clipId: string; dossier: ClipDossier }
  | { kind: "clip-error"; clipId: string; message: string };

export const DOSSIER_VERSION = 3 as const;

/** Default sampling parameters for the visual pass. */
export const FUNNEL_DEFAULTS = {
  sampleFps: 6,
  targetWidth: 256,
  minShotLengthS: 1.0,
  /** Absolute floor for the boundary distance threshold (L1 on normalized hists, range 0..2). */
  boundaryAbsFloor: 0.35,
  /** Multiplier k in mean + k*std adaptive threshold. */
  boundaryK: 3,
  /** Sliding window (in samples) for the adaptive threshold (~4s at 6fps). */
  boundaryWindow: 24,
  /** Capture a frame for dense captioning every this many seconds of media. */
  denseCaptionEveryS: 2,
  /** Rep frame is the sharpest sample within this many seconds of the motion peak. */
  repFramePeakRadiusS: 0.5,
  thumbnailQuality: 0.7,
  /** Embed one frame per this many seconds of shot length... */
  embedFrameEveryS: 8,
  /** ...up to this many frames per shot (rep frame included). */
  maxEmbedFramesPerShot: 6,
} as const;
