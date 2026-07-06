/**
 * Typed message protocols for the three perception workers.
 * Follows the requestId discipline of video/decode-worker.ts.
 */

import type {
  AudioEnvelope,
  AudioEvent,
  InferenceDevice,
  RepFramePixels,
  Shot,
  TranscriptSegment,
} from "./types";
import type { PartialScratchMeta } from "./workers/opfs-scratch";

// ---------------------------------------------------------------------------
// funnel-worker: decode pass + classical metrics + shot detection
// ---------------------------------------------------------------------------

export interface FunnelAnalyzeRequest {
  type: "analyze";
  requestId: string;
  clipId: string;
  blob: Blob;
  sampleFps: number;
  targetWidth: number;
  /**
   * TEST HOOK: pretend the OPFS quota budget is this many bytes, forcing the
   * rolling-window path on small fixtures. Never set in production code.
   */
  debugIngestBudgetBytes?: number;
}

export interface FunnelCancelRequest {
  type: "cancel";
  clipId: string;
}

/** Clear ALL stale OPFS scratch files (sent once on worker startup). */
export interface FunnelInitRequest {
  type: "init";
}

/** Delete one clip's OPFS scratch file (sent when the clip finishes/fails). */
export interface FunnelCleanupRequest {
  type: "cleanup";
  clipId: string;
}

export type FunnelRequest =
  | FunnelAnalyzeRequest
  | FunnelCancelRequest
  | FunnelInitRequest
  | FunnelCleanupRequest;

export interface FunnelMetaResponse {
  type: "meta";
  requestId: string;
  clipId: string;
  durationS: number;
  width: number;
  height: number;
  /** Non-null when quota forced a partial ingest: analysis covers [0, this]. */
  analyzedThroughS: number | null;
}

export interface FunnelProgressResponse {
  type: "progress";
  requestId: string;
  clipId: string;
  t: number;
  framesDone: number;
}

/** Progress of the one-time stream-copy into OPFS scratch. */
export interface FunnelIngestProgressResponse {
  type: "ingest-progress";
  requestId: string;
  clipId: string;
  bytesDone: number;
  bytesTotal: number;
}

/**
 * A finalized shot. All frame buffers are transferred. frames[0] is the
 * representative frame; the rest are sampled across the shot so long shots
 * stay searchable end to end. The thumbnail arrives as a data URL — base64
 * encoding runs in the worker to keep it off the main thread.
 */
export interface FunnelShotResponse {
  type: "shot";
  requestId: string;
  clipId: string;
  shot: Omit<
    Shot,
    "embedding" | "frameEmbeddings" | "thumbnailDataUrl" | "caption" | "cloudCaption"
  >;
  /** JPEG data URL of the representative frame (worker-encoded). */
  thumbDataUrl: string;
  frames: RepFramePixels[];
}

/** A frame sampled every ~denseCaptionEveryS for the caption pass. */
export interface FunnelDenseFrameResponse {
  type: "dense-frame";
  requestId: string;
  clipId: string;
  t: number;
  /** JPEG data URL (worker-encoded base64, ready to store in the dossier). */
  dataUrl: string;
  /** Laplacian variance at scan resolution (blur gate for cloud captioning). */
  sharpness: number;
}

export interface FunnelDoneResponse {
  type: "done";
  requestId: string;
  clipId: string;
  /** True when the clip was ingested to OPFS scratch (whisper should read it from there). */
  usedOpfs: boolean;
  /**
   * Non-null when the scratch ingest is partial (prefix + tail) AND the clip
   * finished single-window (legacy shape, whisper container path reads it).
   * Rolling-window clips report null here — their audio travels via audioPcm.
   */
  partial: PartialScratchMeta | null;
  analyzedThroughS: number | null;
  perf: { decodeMs: number; framesDecoded: number; ingestMs: number };
  /** How many OPFS ingest windows the visual pass used (1 = single copy). */
  ingestWindows: number;
  /**
   * The 16k mono f32le PCM sidecar extracted during the visual pass (scratch
   * key `<clipId>.audio`), or null when the clip has no audio track or
   * extraction failed. When set, the whisper pass reads THIS instead of
   * decoding the container — for windowed clips the video scratch windows
   * are long gone by transcription time.
   */
  audioPcm: { key: string; sampleRate: 16000; durationS: number } | null;
}

/**
 * A rolling-window analysis is moving to its next OPFS window (1-based;
 * emitted at each window START, including the first when windows > 1).
 * analyzedThroughS = source seconds fully covered by completed windows.
 */
export interface FunnelWindowResponse {
  type: "window";
  requestId: string;
  clipId: string;
  window: number;
  windows: number;
  analyzedThroughS: number;
}

export interface FunnelErrorResponse {
  type: "error";
  requestId: string;
  clipId: string;
  message: string;
}

export type FunnelResponse =
  | FunnelMetaResponse
  | FunnelProgressResponse
  | FunnelIngestProgressResponse
  | FunnelWindowResponse
  | FunnelShotResponse
  | FunnelDenseFrameResponse
  | FunnelDoneResponse
  | FunnelErrorResponse;

// ---------------------------------------------------------------------------
// embedding-worker: CLIP text + vision
// ---------------------------------------------------------------------------

export interface EmbedInitRequest {
  type: "init";
  /** "auto" picks webgpu when available, falling back to wasm. */
  device: "auto" | InferenceDevice;
}

export interface EmbedImageRequest {
  type: "embed-image";
  requestId: string;
  pixels: RepFramePixels;
}

export interface EmbedTextRequest {
  type: "embed-text";
  requestId: string;
  text: string;
}

export type EmbedRequest = EmbedInitRequest | EmbedImageRequest | EmbedTextRequest;

export interface EmbedReadyResponse {
  type: "ready";
  device: InferenceDevice;
  dtype: string;
  loadMs: number;
}

export interface EmbedModelProgressResponse {
  type: "model-progress";
  file: string;
  loaded: number;
  total: number;
}

/** vector is the transferred bytes of a 512-d L2-normalized Float32Array. */
export interface EmbedVectorResponse {
  type: "embedding";
  requestId: string;
  vector: ArrayBuffer;
  ms: number;
}

export interface EmbedErrorResponse {
  type: "error";
  requestId: string | null;
  message: string;
}

export type EmbedResponse =
  | EmbedReadyResponse
  | EmbedModelProgressResponse
  | EmbedVectorResponse
  | EmbedErrorResponse;

// ---------------------------------------------------------------------------
// caption-worker: Florence-2 scene descriptions from shot thumbnails
// ---------------------------------------------------------------------------

export interface CaptionInitRequest {
  type: "init";
  device: "auto" | InferenceDevice;
}

export interface CaptionRequest {
  type: "caption";
  requestId: string;
  /** JPEG data URL of the shot's representative frame (from the dossier). */
  image: string;
}

export type CaptionWorkerRequest = CaptionInitRequest | CaptionRequest;

export interface CaptionReadyResponse {
  type: "ready";
  device: InferenceDevice;
  dtype: string;
  loadMs: number;
}

export interface CaptionModelProgressResponse {
  type: "model-progress";
  file: string;
  loaded: number;
  total: number;
}

export interface CaptionTextResponse {
  type: "caption";
  requestId: string;
  caption: string;
  ms: number;
}

export interface CaptionErrorResponse {
  type: "error";
  requestId: string | null;
  message: string;
}

export type CaptionWorkerResponse =
  | CaptionReadyResponse
  | CaptionModelProgressResponse
  | CaptionTextResponse
  | CaptionErrorResponse;

// ---------------------------------------------------------------------------
// whisper-worker: audio decode + resample + ASR
// ---------------------------------------------------------------------------

export interface WhisperInitRequest {
  type: "init";
  device: "auto" | InferenceDevice;
}

export interface WhisperTranscribeRequest {
  type: "transcribe";
  requestId: string;
  clipId: string;
  blob: Blob;
  /** When set, read audio from this OPFS scratch key instead of the blob. */
  opfsKey: string | null;
  /** Layout of a partial scratch ingest (null = full copy). */
  partial: PartialScratchMeta | null;
  /** Cap transcription to this many seconds (partial ingest). */
  capS: number | null;
  /**
   * Decode + loudness envelope ONLY, skip ASR. Used to enrich dossiers
   * cached before audio signals existed without re-running whisper.
   */
  envelopeOnly?: boolean;
  /**
   * When set, the audio is ALREADY 16k mono f32le PCM in this scratch key
   * (extracted by the funnel pass) — read it directly, in bounded chunks,
   * and ignore blob/opfsKey/partial entirely. Long transcriptions MUST NOT
   * materialize the whole clip in one Float32Array: run the ASR in macro
   * chunks (~600s) and offset segment timestamps by each chunk's start.
   */
  pcmKey?: string | null;
}

export type WhisperRequest = WhisperInitRequest | WhisperTranscribeRequest;

export interface WhisperReadyResponse {
  type: "ready";
  device: InferenceDevice;
  loadMs: number;
}

export interface WhisperModelProgressResponse {
  type: "model-progress";
  file: string;
  loaded: number;
  total: number;
}

export interface WhisperSegmentsResponse {
  type: "segments";
  requestId: string;
  clipId: string;
  segments: TranscriptSegment[];
  perf: { audioDecodeMs: number; whisperMs: number; audioDurationS: number };
  /** Loudness envelope of the decoded audio (always computed — it's ~free). */
  audioEnvelope?: AudioEnvelope | null;
  /** Loudness events detected from the envelope. */
  audioEvents?: AudioEvent[];
  /** Echoes the request flag; segments are [] and must NOT overwrite transcript. */
  envelopeOnly?: boolean;
}

export interface WhisperErrorResponse {
  type: "error";
  requestId: string | null;
  clipId: string | null;
  message: string;
}

export type WhisperResponse =
  | WhisperReadyResponse
  | WhisperModelProgressResponse
  | WhisperSegmentsResponse
  | WhisperErrorResponse;
