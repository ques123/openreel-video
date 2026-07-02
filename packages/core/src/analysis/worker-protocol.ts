/**
 * Typed message protocols for the three perception workers.
 * Follows the requestId discipline of video/decode-worker.ts.
 */

import type {
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
 * A finalized shot. thumbJpeg + all frame buffers are transferred.
 * frames[0] is the representative frame; the rest are sampled across the
 * shot so long shots stay searchable end to end.
 */
export interface FunnelShotResponse {
  type: "shot";
  requestId: string;
  clipId: string;
  shot: Omit<Shot, "embedding" | "frameEmbeddings" | "thumbnailDataUrl" | "caption">;
  thumbJpeg: ArrayBuffer;
  frames: RepFramePixels[];
}

/** A frame sampled every ~denseCaptionEveryS for the caption pass (jpeg transferred). */
export interface FunnelDenseFrameResponse {
  type: "dense-frame";
  requestId: string;
  clipId: string;
  t: number;
  jpeg: ArrayBuffer;
}

export interface FunnelDoneResponse {
  type: "done";
  requestId: string;
  clipId: string;
  /** True when the clip was ingested to OPFS scratch (whisper should read it from there). */
  usedOpfs: boolean;
  /** Non-null when the scratch ingest is partial (prefix + tail). */
  partial: PartialScratchMeta | null;
  analyzedThroughS: number | null;
  perf: { decodeMs: number; framesDecoded: number; ingestMs: number };
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
