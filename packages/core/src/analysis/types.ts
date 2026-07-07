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
  /** JPEG data URL (~512px wide) of the representative frame. */
  thumbnailDataUrl: string;
  /** L2-normalized SigLIP2 embedding of the representative frame. Null until embedded. */
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
   * VLM pass). Null until the caption pass reaches this shot. Good for
   * scene gist; may miss small objects or assert details wrongly.
   */
  caption: string | null;
  /**
   * Description from the opt-in cloud vision pass (large model, much more
   * reliable than the local caption). Null unless the user ran an enhance.
   */
  cloudCaption: string | null;
}

/** One timestamped machine scene description from the dense caption pass. */
export interface DenseCaption {
  /** Media time of the described frame, seconds. */
  t: number;
  text: string;
}

/** One frame kept by the adaptive dense sampler (512px JPEG data URL). */
export interface DenseFrame {
  /** Media time, seconds. */
  t: number;
  dataUrl: string;
  /**
   * Laplacian variance of the frame at scan resolution (higher = sharper).
   * Optional: frames captured before this field existed lack it, and no
   * DOSSIER_VERSION bump is warranted for a cost optimization.
   */
  sharpness?: number;
}

/** Provenance of an opt-in cloud vision enhance run. */
export interface CloudVisionMeta {
  model: string;
  scope: "shots" | "timeline";
  /** Epoch ms when the enhance completed. */
  enhancedAt: number;
}

/**
 * Full stats for one cloud enhance run — kept PER SCOPE so shots-only and
 * full-timeline results coexist and their quality/cost/speed can be compared.
 */
export interface CloudRunMeta {
  model: string;
  enhancedAt: number;
  framesSent: number;
  framesFailed: number;
  /** Wall-clock duration of the whole run. */
  ms: number;
  /** Real usage summed across the run's API calls (0 when unreported). */
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from provider cache (subset of promptTokens). */
  cachedTokens?: number;
  /** In-scope frame count before blur-gate/similarity merge (lever-1 datum). */
  preMergeCount?: number;
  /**
   * Exact USD actually billed by the provider for this run, summed across
   * its API calls — set ONLY when every usage-bearing call reported a cost
   * (OpenRouter's `usage.cost`, requested via `usage: {include: true}`; see
   * services/cloud-vision.ts). Absent when unknown: OpenAI never reports a
   * billed cost (its token×rate price IS exact, single provider), an
   * OpenRouter response omitted it, or this run predates cost tracking —
   * callers fall back to the token×rate estimate in all those cases. Never
   * guessed/backfilled, same discipline as promptTokens/completionTokens.
   */
  actualCostUSD?: number;
}

/**
 * One cloud transcription run (opt-in tier; local whisper ALWAYS runs and
 * stays in `transcript`). Times are absolute clip seconds. Cost is exact —
 * derived from billed seconds at the provider's flat audio rate, not a
 * token estimate.
 */
export interface CloudTranscriptMeta {
  /** Provider model id, e.g. "whisper-large-v3-turbo". */
  model: string;
  segments: TranscriptSegment[];
  /** Word-level timestamps; null when the provider returned none. */
  words: { word: string; startS: number; endS: number }[] | null;
  /** Seconds billed (10s minimum per uploaded chunk). */
  billedSeconds: number;
  costUSD: number;
  /** Wall-clock ms for the whole cloud call (encode + upload + parse). */
  ms: number;
  transcribedAt: number;
}

/** Local caption pass stats (speed side of the local-vs-cloud comparison). */
export interface LocalCaptionPerf {
  totalMs: number;
  frames: number;
}

/**
 * One archived cloud enhance run, keyed by (scope, model). Re-running the
 * same combination replaces its entry; different models COEXIST so their
 * quality/cost/speed can be compared over the same frames.
 */
export interface CloudRunArchiveEntry {
  scope: "shots" | "timeline";
  model: string;
  captions: DenseCaption[];
  meta: CloudRunMeta;
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
  /**
   * How many OPFS ingest windows the visual pass used. 1 = whole file fit
   * in one scratch copy (the pre-window behavior). Absent on old dossiers.
   */
  ingestWindows?: number;
}

export interface ClipDossier {
  version: typeof DOSSIER_VERSION;
  /** Per-drop-session id (uuid). */
  clipId: string;
  /** Stable cache key: perception:v1:${name}:${size}:${lastModified}. */
  cacheKey: string;
  fileName: string;
  /**
   * Set when analysis ran on a small stand-in of the real footage (a DJI
   * .LRF proxy dropped alongside the original): the PROXY's file name.
   * Identity (cacheKey, fileName, recordedAt) always belongs to the
   * ORIGINAL; playback/export use the original file. Absent = analyzed
   * from the original pixels.
   */
  analyzedFromProxy?: string | null;
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
   * Frames the adaptive sampler kept during decode (512px JPEGs): one on
   * every meaningful visual change, at most every denseCaptionMaxGapS.
   * Persisted so captions can resume/re-run and cloud enhancement can send
   * real frames — all WITHOUT re-decoding the video.
   */
  denseFrames: DenseFrame[];
  /**
   * Timestamped scene descriptions of the dense frames (local VLM). Far
   * denser than shots — this is how the director "watches" long takes.
   * Grows in the background after analysis.
   */
  denseCaptions: DenseCaption[];
  /** Cloud descriptions of the dense frames (opt-in enhance, scope "timeline"). */
  cloudDenseCaptions: DenseCaption[];
  /**
   * Cloud descriptions from a shots-scope enhance (one per shot, at the shot's
   * rep time). Separate from cloudDenseCaptions so both variants coexist and
   * can be A/B compared against each other and the local pass.
   */
  cloudShotCaptions: DenseCaption[];
  /** Per-scope enhance stats for the LATEST run; null = that scope never ran. */
  cloudRuns: { shots: CloudRunMeta | null; timeline: CloudRunMeta | null };
  /** Every enhance run, one entry per (scope, model) — the A/B record. */
  cloudRunArchive: CloudRunArchiveEntry[];
  /** Legacy "last enhance" marker (kept for the filmstrip badge). */
  cloudVision: CloudVisionMeta | null;
  /** Local caption pass timing; null until the pass finishes at least once. */
  localCaptionPerf: LocalCaptionPerf | null;
  transcript: TranscriptSegment[];
  /**
   * Opt-in cloud transcription (Groq whisper-large-v3-turbo) — coexists with
   * the always-run local `transcript` for A/B comparison, mirroring how
   * cloudDenseCaptions coexists with denseCaptions. Optional + additive: no
   * DOSSIER_VERSION bump; cached dossiers simply lack it until a cloud run.
   */
  cloudTranscript?: CloudTranscriptMeta | null;
  /**
   * Loudness envelope from the audio pass. Optional: dossiers cached before
   * this field existed lack it (no DOSSIER_VERSION bump — it enriches
   * retroactively via an envelope-only audio pass, like captions did).
   */
  audioEnvelope?: AudioEnvelope | null;
  /** Loudness events detected from the envelope. Optional, same reason. */
  audioEvents?: AudioEvent[];
  perf: DossierPerf;
}

/**
 * Coarse loudness envelope of the clip's audio (computed on the same 16k
 * mono samples the whisper pass decodes — no extra decode). Drives the
 * signals UI sparkline and audio-event detection.
 */
export interface AudioEnvelope {
  /** RMS window size, seconds. */
  windowS: number;
  /** One RMS value (0..~1 for float samples) per window, t = index * windowS. */
  rms: number[];
}

/**
 * A loudness event: a run of windows well above the clip's baseline —
 * cheering, laughter, applause, a bang. Selector signal + UI marker.
 */
export interface AudioEvent {
  /** Event start, seconds. */
  t: number;
  /** Event duration, seconds (>= one envelope window). */
  durS: number;
  /** Peak robust z-score vs the clip's baseline loudness. Higher = louder. */
  intensity: number;
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
  | {
      /**
       * A rolling-window analysis moved to its next OPFS window. window is
       * 1-based; analyzedThroughS = source seconds fully covered so far.
       * Single-window clips never emit this.
       */
      kind: "ingest-window";
      clipId: string;
      window: number;
      windows: number;
      analyzedThroughS: number;
    }
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
      kind: "audio-signals";
      clipId: string;
      envelope: AudioEnvelope;
      events: AudioEvent[];
    }
  | {
      kind: "model-progress";
      model: "embed" | "whisper" | "captioner";
      file: string;
      loaded: number;
      total: number;
    }
  | {
      kind: "model-ready";
      model: "embed" | "whisper" | "captioner";
      device: InferenceDevice;
      loadMs: number;
    }
  | {
      /**
       * A cached dossier for this file EXISTS but was invalidated by a
       * DOSSIER_VERSION bump (the version is part of the cache key, so a
       * plain load() just misses). Emitted before the fresh pipeline starts
       * so the UI can label the run "re-analyzing (pipeline updated)"
       * instead of it looking like a brand-new clip.
       */
      kind: "cache-invalidated";
      clipId: string;
      /** DOSSIER_VERSION the stale record was cached under. */
      previousVersion: number;
    }
  | { kind: "clip-done"; clipId: string; dossier: ClipDossier }
  | {
      kind: "clip-error";
      clipId: string;
      message: string;
      /**
       * True when the failure is a deliberate cancelClip() (message is
       * "cancelled"), so the UI can show a distinct cancelled state instead
       * of an error. Absent on real failures.
       */
      cancelled?: boolean;
    };

export const DOSSIER_VERSION = 4 as const;

/** Default sampling parameters for the visual pass. */
export const FUNNEL_DEFAULTS = {
  sampleFps: 6,
  targetWidth: 512,
  minShotLengthS: 1.0,
  /** Absolute floor for the boundary distance threshold (L1 on normalized hists, range 0..2). */
  boundaryAbsFloor: 0.35,
  /** Multiplier k in mean + k*std adaptive threshold. */
  boundaryK: 3,
  /** Sliding window (in samples) for the adaptive threshold (~4s at 6fps). */
  boundaryWindow: 24,
  /** Consider a frame for dense captioning at most every this many seconds. */
  denseCaptionEveryS: 2,
  /**
   * Keep a considered frame only when its HSV-hist distance from the LAST
   * KEPT frame exceeds this (scene visibly changed)... (L1, range 0..2 —
   * cuts land ~0.35+, same-scene drift stays well under 0.1).
   */
  denseCaptionMinDelta: 0.12,
  /** ...or when this many seconds passed since the last kept frame. */
  denseCaptionMaxGapS: 10,
  /** JPEG quality for persisted dense frames (they feed local + cloud captioning). */
  denseFrameQuality: 0.8,
  /** Rep frame is the sharpest sample within this many seconds of the motion peak. */
  repFramePeakRadiusS: 0.5,
  thumbnailQuality: 0.7,
  /** Embed one frame per this many seconds of shot length... */
  embedFrameEveryS: 8,
  /** ...up to this many frames per shot (rep frame included). */
  maxEmbedFramesPerShot: 6,
} as const;
