/**
 * Whisper worker: decodes a clip's audio track with mediabunny's
 * AudioSampleSink (worker-safe; AudioBuffer/Web Audio are Window-only),
 * downmixes to mono, resamples to 16 kHz, and runs Whisper via
 * transformers.js with timestamped chunked long-form decoding.
 */

import { ALL_FORMATS, BlobSource, Input, AudioSampleSink, type Source } from "mediabunny";
import { openPartialScratchSource, openScratchSource } from "./opfs-scratch";
import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { InferenceDevice, TranscriptSegment } from "../types";
import type { WhisperRequest, WhisperResponse } from "../worker-protocol";
import { StreamingResampler } from "../audio-resample";

const MODEL_ID = "onnx-community/whisper-base";
const TARGET_SAMPLE_RATE = 16000;

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

async function transcribe(req: Extract<WhisperRequest, { type: "transcribe" }>) {
  const { requestId, clipId, blob, opfsKey, partial, capS } = req;
  let scratchClose: (() => void) | null = null;
  try {
    const asr = transcriber ?? (await ensureInit("auto"));

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
      source = new BlobSource(blob, { maxCacheSize: 64 * 2 ** 20 });
    }
    const decoded = await decodeAudioTo16kMono(source, capS);
    // Release the exclusive sync-access lock before the long ASR compute.
    scratchClose?.();
    scratchClose = null;
    const audioDecodeMs = performance.now() - decodeStart;

    if (!decoded) {
      // No audio track (or empty) — a valid outcome, not an error.
      post({
        type: "segments",
        requestId,
        clipId,
        segments: [],
        perf: { audioDecodeMs, whisperMs: 0, audioDurationS: 0 },
      });
      return;
    }

    const whisperStart = performance.now();
    const result = (await asr(decoded.audio, {
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
