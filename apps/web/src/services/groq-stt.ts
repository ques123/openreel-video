/**
 * Opt-in cloud transcription tier: Groq-hosted whisper-large-v3-turbo
 * ($0.04/hour of audio, ~216x realtime). Same-origin proxy pattern as
 * openai-proxy.ts/suno.ts: calls go to /api/proxy/groq/* — nginx on abacus
 * rewrites to https://api.groq.com/openai/v1 and injects the API key
 * server-side (dev: vite proxies the path to the deployed nginx over the
 * tailnet), so no key ever exists in the browser.
 *
 * The caller holds a clip's audio as 16kHz mono float32 PCM (the same shape
 * the local whisper-worker consumes). Long audio is sliced into 600s macro
 * chunks — mirrors MACRO_CHUNK_S in
 * packages/core/src/analysis/workers/whisper-worker.ts — and uploaded ONE AT
 * A TIME (sequential, not concurrent) so a slow or failed chunk doesn't
 * strand a pile of others in flight. Each chunk is compressed in-browser to
 * ~24kbps mono Opus (WebCodecs AudioEncoder, muxed into an Ogg container by
 * mediabunny) before upload; browsers without WebCodecs fall back to
 * uncompressed 16-bit WAV, which is still comfortably under Groq's 25MB file
 * limit and the proxy's 30MB body cap for a single 600s chunk.
 *
 * Groq bills per REQUEST with a 10-second minimum, so cost is summed per
 * chunk actually sent, not derived from the clip's raw duration — see
 * billedSecondsForChunk.
 *
 * No UI/orchestrator wiring lives here on purpose — a later wave threads
 * this into the perception lab. This file is self-contained and safe to unit
 * test without a real browser: WebCodecs isn't available under vitest/jsdom,
 * so the encode step always exercises the (equally real) WAV fallback there.
 */

import type { TranscriptSegment } from "@openreel/core";

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------

export const GROQ_BASE = "/api/proxy/groq";
export const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

/** List price, 2026-07 (console.groq.com/pricing) — update by hand if it changes. */
export const GROQ_WHISPER_USD_PER_HOUR = 0.04;

/** Groq (like OpenAI) bills every transcription request as at least this many seconds. */
export const GROQ_MIN_BILLED_SECONDS = 10;

/**
 * Macro-chunk length: mirrors MACRO_CHUNK_S in whisper-worker.ts so the cloud
 * and local paths bound memory (and the blast radius of one failed request)
 * the same way. At 16kHz mono float32, a 600s chunk is 38.4MB of PCM in
 * memory before encoding.
 */
export const CLOUD_CHUNK_S = 600;

const SAMPLE_RATE_HZ = 16000;

/** ~24kbps mono Opus: plenty for ASR (Whisper itself works from 16kHz mono). */
const OPUS_BITRATE_BPS = 24_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CloudTranscriptWord {
  word: string;
  startS: number;
  endS: number;
}

export interface CloudTranscriptResult {
  segments: TranscriptSegment[];
  /** Null only when EVERY chunk's response omitted word-level timestamps entirely. */
  words: CloudTranscriptWord[] | null;
  /** Sum of max(chunkSeconds, GROQ_MIN_BILLED_SECONDS) across every chunk sent. */
  billedSeconds: number;
  costUSD: number;
  model: string;
  /** Wall-clock duration of the whole call. */
  ms: number;
}

export interface TranscribeCloudPcmOptions {
  language?: string;
  signal?: AbortSignal;
  /** Called after each chunk completes with cumulative seconds of audio covered so far. */
  onProgress?: (doneS: number, totalS: number) => void;
}

// ---------------------------------------------------------------------------
// Pure helper: chunk boundary math
// ---------------------------------------------------------------------------

export interface ChunkBounds {
  startSample: number;
  endSample: number;
  startS: number;
  endS: number;
}

/**
 * Slices [0, totalSamples) into fixed chunkS-second windows; the final
 * window is whatever's left over (possibly shorter, never dropped). Pure and
 * independent of any actual PCM data, so it's trivial to test at any scale —
 * callers slice the real Float32Array using the returned sample offsets.
 * Zero samples yields zero chunks (nothing to transcribe, nothing to send).
 */
export function computeChunkBounds(
  totalSamples: number,
  sampleRate: number,
  chunkS: number = CLOUD_CHUNK_S,
): ChunkBounds[] {
  const chunkSamples = Math.round(chunkS * sampleRate);
  const bounds: ChunkBounds[] = [];
  for (let start = 0; start < totalSamples; start += chunkSamples) {
    const end = Math.min(start + chunkSamples, totalSamples);
    bounds.push({
      startSample: start,
      endSample: end,
      startS: start / sampleRate,
      endS: end / sampleRate,
    });
  }
  return bounds;
}

// ---------------------------------------------------------------------------
// Pure helpers: cost accounting
// ---------------------------------------------------------------------------

/** Groq's per-request floor: a 3-second chunk still bills as 10 seconds. */
export function billedSecondsForChunk(chunkDurationS: number): number {
  return Math.max(chunkDurationS, GROQ_MIN_BILLED_SECONDS);
}

export function costUSDForBilledSeconds(
  billedSeconds: number,
  ratePerHour: number = GROQ_WHISPER_USD_PER_HOUR,
): number {
  return (billedSeconds / 3600) * ratePerHour;
}

// ---------------------------------------------------------------------------
// Pure helpers: Groq verbose_json -> core shapes, offset into clip-absolute time
// ---------------------------------------------------------------------------

interface RawGroqSegment {
  start?: number;
  end?: number;
  text?: string;
}

interface RawGroqWord {
  word?: string;
  start?: number;
  end?: number;
}

interface RawGroqVerboseJson {
  segments?: RawGroqSegment[];
  words?: RawGroqWord[] | null;
}

/**
 * Maps Groq's segment shape into the core TranscriptSegment shape
 * ({t0,t1,text}), offsetting into clip-absolute seconds by the chunk's
 * start. Blank/whitespace-only segments are dropped, same as the local
 * whisper-worker.
 */
export function toTranscriptSegments(
  raw: RawGroqSegment[] | undefined,
  offsetS: number,
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of raw ?? []) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    out.push({ t0: (s.start ?? 0) + offsetS, t1: (s.end ?? 0) + offsetS, text });
  }
  return out;
}

/**
 * Null means "this chunk's response had no words field at all" (absent or
 * null on the wire) — distinct from a present-but-empty array (a silent
 * chunk with word-level granularity honored, just nothing to report), which
 * returns []. transcribeCloudPcm uses that distinction to decide whether the
 * WHOLE run's words should collapse to null.
 */
export function toTranscriptWords(
  raw: RawGroqWord[] | null | undefined,
  offsetS: number,
): CloudTranscriptWord[] | null {
  if (!raw) return null;
  return raw.map((w) => ({
    word: w.word ?? "",
    startS: (w.start ?? 0) + offsetS,
    endS: (w.end ?? 0) + offsetS,
  }));
}

// ---------------------------------------------------------------------------
// Pure helper: 16-bit WAV encoder (no-WebCodecs fallback)
// ---------------------------------------------------------------------------

const WAV_HEADER_BYTES = 44;

/**
 * Hand-rolled mono 16-bit PCM WAV — the fallback when WebCodecs/mediabunny
 * Opus muxing isn't available. A 600s chunk at 16kHz is ~19MB, comfortably
 * under both Groq's 25MB file limit and the proxy's 30MB body cap. A pure
 * function of the sample data, so it's directly testable byte-for-byte.
 */
export function encodeWavBytes(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format: 1 = PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align (mono, 16-bit)
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(scaled), true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWavBytes(samples, sampleRate)], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Pure helper: multipart field assembly
// ---------------------------------------------------------------------------

/**
 * Non-file fields for the transcription request, as [name, value] pairs (in
 * send order) so the exact set can be asserted without constructing a real
 * FormData/fetch. `language` is included only when provided — Groq
 * auto-detects otherwise.
 */
export function buildGroqFormFields(language?: string): [string, string][] {
  const fields: [string, string][] = [
    ["model", GROQ_WHISPER_MODEL],
    ["response_format", "verbose_json"],
    ["timestamp_granularities[]", "segment"],
    ["timestamp_granularities[]", "word"],
  ];
  if (language) fields.push(["language", language]);
  return fields;
}

function buildFormData(blob: Blob, filename: string, language: string | undefined): FormData {
  const form = new FormData();
  form.append("file", blob, filename);
  for (const [key, value] of buildGroqFormFields(language)) form.append(key, value);
  return form;
}

// ---------------------------------------------------------------------------
// Encoding: WebCodecs Opus (preferred), 16-bit WAV fallback
// ---------------------------------------------------------------------------

let warnedWavFallback = false;

/**
 * Encodes raw audio with the browser's WebCodecs AudioEncoder and muxes the
 * resulting packets into an Ogg container with mediabunny. mediabunny never
 * touches the encoder itself here — EncodedAudioPacketSource only accepts
 * already-encoded packets — so this whole path is skipped when AudioEncoder
 * doesn't exist (feature-checked by the caller, encodeChunkAudio).
 */
async function encodeOpusOgg(
  samples: Float32Array,
  sampleRate: number,
): Promise<{ blob: Blob; filename: string }> {
  const { Output, BufferTarget, OggOutputFormat, EncodedAudioPacketSource, EncodedPacket } =
    await import("mediabunny");

  const target = new BufferTarget();
  const output = new Output({ format: new OggOutputFormat(), target });
  const source = new EncodedAudioPacketSource("opus");
  output.addAudioTrack(source);
  await output.start();

  const pending: Promise<void>[] = [];
  let encodeError: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      pending.push(source.add(EncodedPacket.fromEncodedChunk(chunk), meta));
    },
    error: (err) => {
      encodeError = err;
    },
  });
  encoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels: 1,
    bitrate: OPUS_BITRATE_BPS,
  });

  const audioData = new AudioData({
    // TS's dom lib pins AudioDataInit.data to ArrayBuffer-backed views (excludes
    // SharedArrayBuffer); the PCM flowing through this whole app is always a
    // plain ArrayBuffer, so this narrows a type-only mismatch, not a real one.
    data: samples as Float32Array<ArrayBuffer>,
    format: "f32-planar",
    numberOfChannels: 1,
    numberOfFrames: samples.length,
    sampleRate,
    timestamp: 0,
  });
  encoder.encode(audioData);
  audioData.close();

  await encoder.flush();
  encoder.close();
  if (encodeError) {
    const err = encodeError;
    const message =
      err instanceof Error && err.name && err.name !== "Error"
        ? `${err.name}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`groq stt: opus encode failed: ${message}`);
  }

  await Promise.all(pending);
  await output.finalize();

  if (!target.buffer) throw new Error("groq stt: opus encode produced an empty buffer");
  return { blob: new Blob([target.buffer], { type: "audio/ogg" }), filename: "chunk.ogg" };
}

/**
 * Encodes one chunk for upload: ~24kbps mono Opus/Ogg when WebCodecs is
 * available, else a 16-bit WAV (warns once — the WAV path uploads roughly
 * 10x more bytes). Any failure in the Opus path — not just its absence —
 * also falls back, rather than failing the whole transcription over a codec
 * hiccup on one chunk.
 */
async function encodeChunkAudio(
  samples: Float32Array,
  sampleRate: number,
): Promise<{ blob: Blob; filename: string }> {
  if (typeof AudioEncoder !== "undefined") {
    try {
      return await encodeOpusOgg(samples, sampleRate);
    } catch (err) {
      console.warn("[groq-stt] Opus encode failed, falling back to WAV upload:", err);
    }
  }
  if (!warnedWavFallback) {
    warnedWavFallback = true;
    console.warn(
      "[groq-stt] WebCodecs Opus encoding unavailable — uploading uncompressed 16-bit WAV " +
        `chunks instead (~${Math.round((CLOUD_CHUNK_S * sampleRate * 2) / 1e6)}MB per ` +
        `${CLOUD_CHUNK_S}s chunk vs ~2MB for Opus). Still under Groq's 25MB file limit.`,
    );
  }
  return { blob: encodeWavBlob(samples, sampleRate), filename: "chunk.wav" };
}

// ---------------------------------------------------------------------------
// Network: one chunk, with the house error-mapping + single-retry convention
// ---------------------------------------------------------------------------

interface ChunkTranscript {
  segments: TranscriptSegment[];
  words: CloudTranscriptWord[] | null;
}

function proxyNotConfiguredError(): Error {
  return new Error(
    "groq stt: proxy route is not set up on the server (got HTML/404 instead of JSON) — " +
      "run docs/groq-proxy/apply-groq-proxy.sh on abacus",
  );
}

async function postChunk(
  blob: Blob,
  filename: string,
  offsetS: number,
  language: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ChunkTranscript> {
  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    body: buildFormData(blob, filename, language),
    signal,
  });

  if (res.status === 404) throw proxyNotConfiguredError();
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Groq key missing or invalid in /etc/nginx/snippets/groq-key.conf " +
        "(get a gsk_ key at console.groq.com)",
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
  }
  // An unproxied path falls through to the SPA and returns 200 text/html —
  // catch that before json() turns it into a cryptic SyntaxError.
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw proxyNotConfiguredError();
  }

  const data = (await res.json()) as RawGroqVerboseJson;
  return {
    segments: toTranscriptSegments(data.segments, offsetS),
    words: toTranscriptWords(data.words, offsetS),
  };
}

/** One retry on failure (mirrors describeFramesCloud in cloud-vision.ts) — a chunk failing twice throws. */
async function postChunkWithRetry(
  blob: Blob,
  filename: string,
  offsetS: number,
  language: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ChunkTranscript> {
  try {
    return await postChunk(blob, filename, offsetS, language, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    return await postChunk(blob, filename, offsetS, language, signal); // one retry; a second failure propagates
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Transcribes 16kHz mono PCM through Groq's whisper-large-v3-turbo. Slices
 * into CLOUD_CHUNK_S-second chunks, encodes and uploads them ONE AT A TIME —
 * not concurrently, so one stuck chunk doesn't strand five others — and
 * concatenates the results with each chunk's segments/words offset into
 * clip-absolute seconds. A chunk that fails twice (see postChunkWithRetry)
 * rejects the whole call: a partial transcript silently missing minutes of a
 * clip is worse than a clear failure.
 */
export async function transcribeCloudPcm(
  pcm: Float32Array,
  opts: TranscribeCloudPcmOptions = {},
): Promise<CloudTranscriptResult> {
  const startMs = performance.now();
  const bounds = computeChunkBounds(pcm.length, SAMPLE_RATE_HZ);
  const totalS = pcm.length / SAMPLE_RATE_HZ;

  const segments: TranscriptSegment[] = [];
  const words: CloudTranscriptWord[] = [];
  let anyWords = false;
  let billedSeconds = 0;

  for (const bound of bounds) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

    const chunkSamples = pcm.subarray(bound.startSample, bound.endSample);
    const { blob, filename } = await encodeChunkAudio(chunkSamples, SAMPLE_RATE_HZ);
    const result = await postChunkWithRetry(blob, filename, bound.startS, opts.language, opts.signal);

    segments.push(...result.segments);
    if (result.words) {
      anyWords = true;
      words.push(...result.words);
    }
    billedSeconds += billedSecondsForChunk(bound.endS - bound.startS);
    opts.onProgress?.(bound.endS, totalS);
  }

  return {
    segments,
    words: anyWords ? words : null,
    billedSeconds,
    costUSD: costUSDForBilledSeconds(billedSeconds),
    model: GROQ_WHISPER_MODEL,
    ms: Math.round(performance.now() - startMs),
  };
}
