/**
 * Whisper worker: decodes a clip's audio track with mediabunny's
 * AudioSampleSink (worker-safe; AudioBuffer/Web Audio are Window-only),
 * downmixes to mono, resamples to 16 kHz, and runs Whisper via
 * transformers.js with timestamped chunked long-form decoding.
 */

import { ALL_FORMATS, BlobSource, Input, AudioSampleSink, type Source } from "mediabunny";
import {
  availableQuota,
  copyBlobToScratch,
  deleteScratchEntry,
  openPartialScratchSource,
  openPcmScratch,
  openScratchSource,
  planAudioBackfillRoute,
  type PcmScratchReader,
} from "./opfs-scratch";
import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { AudioEnvelope, InferenceDevice, TranscriptSegment } from "../types";
import type { WhisperRequest, WhisperResponse } from "../worker-protocol";
import { StreamingResampler } from "../audio-resample";
import { computeAudioEnvelope, detectAudioEvents } from "../audio-signal";

const MODEL_ID = "onnx-community/whisper-base";
const TARGET_SAMPLE_RATE = 16000;
/**
 * PCM sidecar path only: read/transcribe `<clipId>.audio` in fixed-size
 * macro-chunks instead of materializing the whole clip, so peak memory is
 * bounded regardless of clip length. 600s * 16000Hz = 9.6M samples = 38.4MB
 * per Float32Array chunk. Also an exact multiple of AUDIO_ENVELOPE_WINDOW_S
 * (0.25s => 2400 windows/chunk), so concatenating per-chunk envelopes needs
 * no boundary reconciliation — only the clip's final, possibly shorter,
 * chunk can leave a trailing partial window (same rule computeAudioEnvelope
 * already applies within a single whole-clip call).
 */
const MACRO_CHUNK_S = 600;
const MACRO_CHUNK_SAMPLES = TARGET_SAMPLE_RATE * MACRO_CHUNK_S;

function post(message: WhisperResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(message, { transfer: transfer ?? [] });
}

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let transcriberDevice: InferenceDevice = "wasm";
let initPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

async function init(
  requested: "auto" | InferenceDevice,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const startMs = performance.now();
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  const device: InferenceDevice =
    requested === "wasm" || !hasWebGPU ? "wasm" : "webgpu";

  const progress_callback = (p: unknown) => {
    const info = p as { status?: string; file?: string; loaded?: number; total?: number };
    if (info.status === "progress" && info.file) {
      post({
        type: "model-progress",
        file: info.file,
        loaded: info.loaded ?? 0,
        total: info.total ?? 0,
      });
    }
  };

  const load = (dev: InferenceDevice) =>
    pipeline("automatic-speech-recognition", MODEL_ID, {
      device: dev,
      dtype: {
        encoder_model: "fp32",
        decoder_model_merged: dev === "webgpu" ? "q4" : "q8",
      },
      progress_callback,
    });

  try {
    transcriber = await load(device);
    transcriberDevice = device;
  } catch (err) {
    if (device === "webgpu") {
      transcriber = await load("wasm");
      transcriberDevice = "wasm";
    } else {
      throw err;
    }
  }

  post({ type: "ready", device: transcriberDevice, loadMs: performance.now() - startMs });
  return transcriber;
}

function ensureInit(
  requested: "auto" | InferenceDevice,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!initPromise) {
    initPromise = init(requested).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/**
 * Decode the audio track to mono 16 kHz Float32Array, streaming: each
 * AudioSample is downmixed and resampled immediately, then released.
 */
async function decodeAudioTo16kMono(
  source: Source,
  capS: number | null,
): Promise<{ audio: Float32Array; durationS: number } | null> {
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;

    const sink = new AudioSampleSink(track);
    let resampler: StreamingResampler | null = null;
    let passthrough: Float32Array[] | null = null;
    let sourceRate = 0;
    let totalFrames = 0;
    let interleaved = new Float32Array(0);

    for await (const sample of sink.samples(0, capS ?? undefined)) {
      sourceRate = sample.sampleRate;
      const channels = sample.numberOfChannels;
      const frames = sample.numberOfFrames;
      if (interleaved.length < frames * channels) {
        interleaved = new Float32Array(frames * channels);
      }
      sample.copyTo(interleaved, { planeIndex: 0, format: "f32" });
      sample.close();

      const mono = new Float32Array(frames);
      if (channels === 1) {
        mono.set(interleaved.subarray(0, frames));
      } else {
        for (let f = 0; f < frames; f += 1) {
          let sum = 0;
          const base = f * channels;
          for (let c = 0; c < channels; c += 1) sum += interleaved[base + c];
          mono[f] = sum / channels;
        }
      }
      totalFrames += frames;

      if (sourceRate === TARGET_SAMPLE_RATE) {
        (passthrough ??= []).push(mono);
      } else {
        (resampler ??= new StreamingResampler(sourceRate / TARGET_SAMPLE_RATE)).push(mono);
      }
    }

    if (totalFrames === 0 || sourceRate === 0) return null;
    const durationS = totalFrames / sourceRate;

    if (passthrough) {
      const joined = new Float32Array(totalFrames);
      let offset = 0;
      for (const chunk of passthrough) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return { audio: joined, durationS };
    }
    return { audio: resampler!.finish(), durationS };
  } finally {
    input.dispose();
  }
}

interface WhisperChunk {
  timestamp: [number, number | null];
  text: string;
}

/**
 * PCM sidecar transcription: reads `<clipId>.audio` (16k mono f32le, written
 * by the funnel's visual pass) in MACRO_CHUNK_S macro-chunks so a many-hour
 * clip never materializes as a single Float32Array. The envelope and ASR
 * both run per chunk; results are concatenated/offset back into one
 * clip-wide response shaped like the legacy container path's below.
 */
async function transcribeFromPcm(
  requestId: string,
  clipId: string,
  pcmKey: string,
  envelopeOnly: boolean | undefined,
) {
  let reader: PcmScratchReader | null = null;
  try {
    const asr = envelopeOnly ? null : (transcriber ?? (await ensureInit("auto")));

    reader = await openPcmScratch(pcmKey);
    const durationS = reader.sampleCount / TARGET_SAMPLE_RATE;

    if (reader.sampleCount === 0) {
      // No audio track (or extraction failed) — same "computed, no audio"
      // shape as the legacy no-track case below, not an error.
      post({
        type: "segments",
        requestId,
        clipId,
        segments: [],
        perf: { audioDecodeMs: 0, whisperMs: 0, audioDurationS: 0 },
        audioEnvelope: null,
        audioEvents: [],
        envelopeOnly,
      });
      return;
    }

    let offsetSamples = 0;
    let audioDecodeMs = 0;
    let whisperMs = 0;
    let windowS = 0;
    const rms: number[] = [];
    const segments: TranscriptSegment[] = [];

    // One sync-access handle held open across every chunk — only the
    // per-chunk Float32Array is bounded, never the whole clip.
    while (offsetSamples < reader.sampleCount) {
      const chunkLen = Math.min(MACRO_CHUNK_SAMPLES, reader.sampleCount - offsetSamples);

      const readStart = performance.now();
      const chunkSamples = reader.read(offsetSamples, chunkLen);
      audioDecodeMs += performance.now() - readStart;

      // Concatenate per-chunk envelopes: MACRO_CHUNK_S is an exact multiple
      // of the 0.25s envelope window, so only the clip's FINAL (possibly
      // shorter) chunk can leave a trailing partial window — the same rule
      // computeAudioEnvelope already applies within a single whole-clip call.
      const chunkEnvelope = computeAudioEnvelope(chunkSamples, TARGET_SAMPLE_RATE);
      windowS = chunkEnvelope.windowS;
      rms.push(...chunkEnvelope.rms);

      if (!envelopeOnly) {
        const chunkStartS = offsetSamples / TARGET_SAMPLE_RATE;
        const chunkDurationS = chunkSamples.length / TARGET_SAMPLE_RATE;
        const whisperStart = performance.now();
        const result = (await asr!(chunkSamples, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
        })) as { chunks?: WhisperChunk[] };
        whisperMs += performance.now() - whisperStart;

        // v1 limitation: each macro-chunk is transcribed independently (no
        // ASR context carried across the chunk seam), so a word spoken right
        // at a chunk boundary can be split or mistranscribed. Acceptable for
        // v1 — chunks are minutes long, so this is rare in practice.
        for (const c of result.chunks ?? []) {
          const text = c.text.trim();
          if (!text) continue;
          segments.push({
            t0: (c.timestamp[0] ?? 0) + chunkStartS,
            t1: (c.timestamp[1] ?? chunkDurationS) + chunkStartS,
            text,
          });
        }
      }

      offsetSamples += chunkSamples.length;
    }

    const audioEnvelope: AudioEnvelope = { windowS, rms };
    const audioEvents = detectAudioEvents(audioEnvelope);

    post({
      type: "segments",
      requestId,
      clipId,
      segments,
      perf: { audioDecodeMs, whisperMs, audioDurationS: durationS },
      audioEnvelope,
      audioEvents,
      envelopeOnly,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name && err.name !== "Error"
        ? `${err.name}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    post({ type: "error", requestId, clipId, message });
  } finally {
    reader?.close();
  }
}

async function transcribe(req: Extract<WhisperRequest, { type: "transcribe" }>) {
  const { requestId, clipId, blob, opfsKey, partial, capS, envelopeOnly, pcmKey } = req;

  // PCM sidecar path: the funnel's visual pass already extracted 16k mono
  // f32le audio to OPFS scratch (`<clipId>.audio`). Rolling-window clips
  // delete their video scratch windows as they're consumed, so by
  // transcription time there is no container left for the legacy path
  // below to decode — read the sidecar instead and ignore
  // blob/opfsKey/partial entirely.
  if (pcmKey) {
    await transcribeFromPcm(requestId, clipId, pcmKey, envelopeOnly);
    return;
  }

  let scratchClose: (() => void) | null = null;
  /** Temporary scratch copy made for THIS request (deleted before returning). */
  let tempScratchKey: string | null = null;
  try {
    // envelopeOnly requests never touch the ASR pipeline, so they don't wait
    // on (or trigger) model init — a cache backfill pass can complete before
    // whisper has finished downloading, and doesn't require it at all.
    const asr = envelopeOnly ? null : (transcriber ?? (await ensureInit("auto")));

    const decodeStart = performance.now();
    // Prefer the OPFS scratch copy (sync-access reads, no blob machinery);
    // fall back to the dropped File when ingest was skipped (small files only).
    let source: Source;
    if (opfsKey && partial) {
      const scratch = await openPartialScratchSource(opfsKey, partial);
      scratchClose = scratch.close;
      source = scratch.source;
    } else if (opfsKey) {
      const scratch = await openScratchSource(opfsKey);
      scratchClose = scratch.close;
      source = scratch.source;
    } else {
      // No scratch copy exists for this clip (audio-signal backfill of a
      // legacy cached dossier, or the small-file blob-fallback path). Raw
      // BlobSource reads are random-access blob slices — the exact pattern
      // that leaked browser-process memory and crashed Chrome at 17GB — so
      // gate by size: big files get a one-off sequential scratch copy
      // (leak-free) when quota allows, and are SKIPPED when it doesn't.
      const route = planAudioBackfillRoute(blob.size, await availableQuota());
      if (route === "blob") {
        source = new BlobSource(blob, { maxCacheSize: 64 * 2 ** 20 });
      } else if (route === "scratch-copy") {
        tempScratchKey = `${clipId}.enrich`;
        await copyBlobToScratch(blob, tempScratchKey);
        const scratch = await openScratchSource(tempScratchKey);
        scratchClose = scratch.close;
        source = scratch.source;
      } else {
        const sizeGb = (blob.size / 1e9).toFixed(1);
        console.warn(
          `[perception] skipping audio pass for "${clipId}": ${sizeGb}GB file ` +
            `is too large for raw blob reads (browser-crash risk) and doesn't ` +
            `fit in OPFS scratch quota. Audio signals stay unfilled.`,
        );
        post({
          type: "error",
          requestId,
          clipId,
          message: `audio pass skipped: ${sizeGb}GB file exceeds safe blob-read size and available scratch quota`,
        });
        return;
      }
    }
    const decoded = await decodeAudioTo16kMono(source, capS);
    // Release the exclusive sync-access lock before the long ASR compute,
    // and drop the temporary multi-GB scratch copy — the PCM is in memory now.
    scratchClose?.();
    scratchClose = null;
    if (tempScratchKey) {
      await deleteScratchEntry(tempScratchKey);
      tempScratchKey = null;
    }
    const audioDecodeMs = performance.now() - decodeStart;

    if (!decoded) {
      // No audio track (or empty) — a valid outcome, not an error. Envelope
      // is explicitly null (computed, no audio) rather than omitted, so the
      // orchestrator can tell "no audio" apart from "never computed".
      post({
        type: "segments",
        requestId,
        clipId,
        segments: [],
        perf: { audioDecodeMs, whisperMs: 0, audioDurationS: 0 },
        audioEnvelope: null,
        audioEvents: [],
        envelopeOnly,
      });
      return;
    }

    // Always compute the loudness envelope + events — it's microseconds of
    // work on the same samples the ASR pass (or nothing, for envelopeOnly)
    // is about to consume.
    const audioEnvelope = computeAudioEnvelope(decoded.audio, TARGET_SAMPLE_RATE);
    const audioEvents = detectAudioEvents(audioEnvelope);

    if (envelopeOnly) {
      post({
        type: "segments",
        requestId,
        clipId,
        segments: [],
        perf: { audioDecodeMs, whisperMs: 0, audioDurationS: decoded.durationS },
        audioEnvelope,
        audioEvents,
        envelopeOnly: true,
      });
      return;
    }

    const whisperStart = performance.now();
    const result = (await asr!(decoded.audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    })) as { chunks?: WhisperChunk[] };
    const whisperMs = performance.now() - whisperStart;

    const segments: TranscriptSegment[] = (result.chunks ?? [])
      .filter((c) => c.text.trim().length > 0)
      .map((c) => ({
        t0: c.timestamp[0] ?? 0,
        t1: c.timestamp[1] ?? decoded.durationS,
        text: c.text.trim(),
      }));

    post({
      type: "segments",
      requestId,
      clipId,
      segments,
      perf: { audioDecodeMs, whisperMs, audioDurationS: decoded.durationS },
      audioEnvelope,
      audioEvents,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name && err.name !== "Error"
        ? `${err.name}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    post({ type: "error", requestId, clipId, message });
  } finally {
    scratchClose?.();
    // Error-path cleanup: the happy path already deleted it after decode.
    if (tempScratchKey) await deleteScratchEntry(tempScratchKey);
  }
}

// Serialize transcribe requests: the ASR pipeline is not reentrant-safe and
// concurrent audio decodes would just thrash memory.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<WhisperRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    ensureInit(msg.device).catch((err) => {
      post({
        type: "error",
        requestId: null,
        clipId: null,
        message: err.message ?? String(err),
      });
    });
  } else {
    queue = queue.then(() => transcribe(msg));
  }
};
