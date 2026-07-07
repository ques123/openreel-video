/**
 * Whisper worker: decodes a clip's audio track with mediabunny's
 * AudioSampleSink (worker-safe; AudioBuffer/Web Audio are Window-only),
 * downmixes to mono, resamples to 16 kHz, and runs Whisper via
 * transformers.js with timestamped chunked long-form decoding.
 *
 * Before transcribing, a VAD gate (Silero, falling back to an energy gate)
 * detects speech regions so whisper only ever sees speech — see the "VAD
 * gate" section below and packages/core/src/analysis/vad-regions.ts.
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
import {
  pipeline,
  AutoModel,
  Tensor,
  PretrainedConfig,
  type AutomaticSpeechRecognitionPipeline,
  type PreTrainedModel,
} from "@huggingface/transformers";
import type { AudioEnvelope, InferenceDevice, TranscriptSegment } from "../types";
import type { WhisperRequest, WhisperResponse, WhisperModelId } from "../worker-protocol";
import { WHISPER_MODEL_IDS } from "../worker-protocol";
import { StreamingResampler } from "../audio-resample";
import { computeAudioEnvelope, computeEnergyGateRegions, detectAudioEvents } from "../audio-signal";
import { offsetSegments, processVadRegions, type VadRegion } from "../vad-regions";

const TARGET_SAMPLE_RATE = 16000;
/**
 * PCM sidecar path only: read/transcribe `<clipId>.audio` in fixed-size
 * macro-chunks instead of materializing the whole clip, so peak memory is
 * bounded regardless of clip length. 600s * 16000Hz = 9.6M samples = 38.4MB
 * per Float32Array chunk. Also an exact multiple of AUDIO_ENVELOPE_WINDOW_S
 * (0.25s => 2400 windows/chunk) AND of VAD_FRAME_SAMPLES (512 => 18,750
 * frames/chunk), so concatenating per-chunk envelopes/VAD scans needs no
 * boundary reconciliation — only the clip's final, possibly shorter, chunk
 * can leave a trailing partial window/frame (same rule computeAudioEnvelope
 * already applies within a single whole-clip call). Also reused as
 * vad-regions.ts's maxRegionS: a VAD-gated region never exceeds the same
 * bound the non-gated path already reads in one piece.
 */
const MACRO_CHUNK_S = 600;
const MACRO_CHUNK_SAMPLES = TARGET_SAMPLE_RATE * MACRO_CHUNK_S;

function post(message: WhisperResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(message, { transfer: transfer ?? [] });
}

// ---------------------------------------------------------------------------
// Whisper model loading: selectable base|large-v3-turbo, at most ONE
// resident at a time (base ~80MB vs large-v3-turbo ~800MB). Model choice
// applies at analyze time only — a cached dossier keeps whatever transcript
// it was originally analyzed with; switching the default doesn't
// retroactively re-transcribe cache hits (see enrichAudioSignals in
// funnel-orchestrator.ts, which never sets `model` — envelopeOnly requests
// never load a model at all, see transcribe()/transcribeFromPcm() below).
// ---------------------------------------------------------------------------

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let transcriberDevice: InferenceDevice = "wasm";
let loadedModelKey: WhisperModelId | null = null;
/**
 * Serializes EVERY whisper (re)load — the eager "init" warm-up message AND
 * any transcribe request's lazy trigger — through one chain. Without this,
 * a model switch that races the initial warm-up (e.g. the very first
 * transcribe request asks for "large-v3-turbo" while the warm-up's "base"
 * download is still in flight) could load two pipelines concurrently,
 * violating "at most one resident". Each link always RESOLVES (errors are
 * swallowed for chain-continuation purposes only — see `ensureInit`) so one
 * failed load doesn't wedge every later request.
 */
let modelChain: Promise<void> = Promise.resolve();

/** (Re)loads `modelKey`, disposing the outgoing pipeline once the new one is confirmed working. */
async function loadWhisperModel(
  requested: "auto" | InferenceDevice,
  modelKey: WhisperModelId,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const startMs = performance.now();
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  const device: InferenceDevice = requested === "wasm" || !hasWebGPU ? "wasm" : "webgpu";
  const modelId = WHISPER_MODEL_IDS[modelKey];
  const previous = transcriber;

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
    pipeline("automatic-speech-recognition", modelId, {
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
  loadedModelKey = modelKey;

  // At most ONE whisper model resident at a time: release the OUTGOING
  // pipeline's ONNX session(s) now that the new one has loaded successfully.
  // Disposing AFTER (not before) the new load succeeds means a failed model
  // switch leaves the previous model still usable instead of leaving the
  // worker with none.
  if (previous && previous !== transcriber) {
    await previous.dispose().catch(() => undefined);
  }

  post({
    type: "ready",
    device: transcriberDevice,
    model: modelKey,
    loadMs: performance.now() - startMs,
  });
  return transcriber;
}

/**
 * Ensure `modelKey` is the currently loaded whisper model, (re)loading only
 * if needed. Always goes through `modelChain` (see its doc) — even the
 * common "already loaded, nothing to do" case pays one microtask tick, a
 * negligible cost for guaranteeing model switches can't race.
 */
function ensureInit(
  requested: "auto" | InferenceDevice,
  modelKey: WhisperModelId,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const result = modelChain.then(() => {
    if (transcriber && loadedModelKey === modelKey) return transcriber;
    return loadWhisperModel(requested, modelKey);
  });
  // The chain link always resolves so a failure doesn't wedge later turns;
  // the caller's own `result` promise still rejects normally.
  modelChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ---------------------------------------------------------------------------
// VAD gate: detect speech regions before transcription so wind/music/silence
// never reaches whisper (kills most hallucinations, speeds up quiet
// footage). Silero VAD (tiny, ~2MB) is the primary backend; a failure to
// load OR run it falls back — permanently for this worker's lifetime, with
// a single console.warn — to computeEnergyGateRegions (audio-signal.ts), a
// pure energy/robust-z gate over the RMS envelope that's already being
// computed regardless of VAD. Both backends produce the same raw
// `VadRegion[]` shape; vad-regions.ts's processVadRegions (merge/pad/drop/
// split) turns either into the final regions actually transcribed.
// ---------------------------------------------------------------------------

/** onnx-community's transformers.js-ready packaging of Silero VAD v5 (combined LSTM state). */
const SILERO_MODEL_ID = "onnx-community/silero-vad";
/** Silero's own frame size at 16kHz (32ms/frame) — unrelated to whisper's macro-chunking. */
const VAD_FRAME_SAMPLES = 512;
/**
 * Speech-probability threshold a frame must clear to seed a raw region.
 * Silero's own docs/demos default to 0.5 for offline/batch use; real-time
 * barge-in demos (e.g. transformers.js-examples/conversational-webgpu) use a
 * lower, asymmetric enter/exit pair instead — a latency-vs-recall tradeoff
 * for interactive mic input that doesn't apply to this whole-clip offline
 * pass. Brief dips below threshold mid-sentence are bridged by
 * vad-regions.ts's merge/pad, not by hysteresis here.
 */
const SILERO_SPEECH_THRESHOLD = 0.5;
/** Combined (h,c) LSTM state shape the v5 combined-state silero-vad graph expects. */
const SILERO_STATE_SHAPE = [2, 1, 128];

let vadUnavailable = false;
let vadWarned = false;
let vadInitPromise: Promise<PreTrainedModel | null> | null = null;

/** Console.warn exactly once per worker lifetime, regardless of how many clips hit the fallback. */
function warnVadFallback(reason: unknown) {
  if (vadWarned) return;
  vadWarned = true;
  console.warn(
    "[perception] Silero VAD unavailable, falling back to the energy-based speech gate:",
    reason,
  );
}

/**
 * Lazily load Silero VAD once; a load failure is cached permanently
 * (`vadUnavailable`) so later clips don't retry a doomed download every
 * time — they just fall back. Runtime (post-load) failures are handled by
 * the scanner's caller, which also sets `vadUnavailable` permanently: a
 * model that breaks mid-scan once is unlikely to recover.
 */
function ensureSileroVad(): Promise<PreTrainedModel | null> {
  if (vadUnavailable) return Promise.resolve(null);
  if (vadInitPromise) return vadInitPromise;
  vadInitPromise = (async () => {
    try {
      // Tiny (~2MB) recurrent model: wasm avoids WebGPU dispatch overhead
      // dominating its many small per-512-sample-frame calls, and keeps it
      // off whatever GPU context the whisper pipeline may itself be using.
      // `config` bypasses fetching a (nonexistent) config.json for this
      // repo — the model card ships no config.json at all, only the ONNX
      // graph, exactly like transformers.js's own realtime-VAD examples.
      return await AutoModel.from_pretrained(SILERO_MODEL_ID, {
        config: new PretrainedConfig({ model_type: "custom" }),
        dtype: "fp32",
        device: "wasm",
      });
    } catch (err) {
      vadUnavailable = true;
      warnVadFallback(err);
      return null;
    }
  })();
  return vadInitPromise;
}

/**
 * Per-clip Silero scan state: `state` is the recurrent (h,c) tensor,
 * threaded across EVERY frame of the whole clip (never reset mid-clip) for
 * temporal coherence; `sr` is a constant scalar (sample rate) tensor.
 */
function createSileroScanState(): { sr: Tensor; state: Tensor } {
  return {
    sr: new Tensor("int64", [TARGET_SAMPLE_RATE], []),
    state: new Tensor("float32", new Float32Array(2 * 1 * 128), SILERO_STATE_SHAPE),
  };
}

/**
 * Scan one span of samples for raw speech regions, in ABSOLUTE clip time
 * (spanStartS offsets every frame). Mutates `scan.state` in place so the
 * caller can keep threading it across further calls (e.g. one call per
 * macro-chunk covering the whole clip). Only a trailing <512-sample
 * remainder is dropped (<32ms of tail audio; MACRO_CHUNK_SAMPLES is an
 * exact multiple of VAD_FRAME_SAMPLES so this can only happen on a clip's
 * FINAL chunk — see the module doc on MACRO_CHUNK_S). Throws on model
 * failure; callers decide how to fall back.
 */
async function scanSileroSpan(
  model: PreTrainedModel,
  scan: { sr: Tensor; state: Tensor },
  samples: Float32Array,
  spanStartS: number,
): Promise<VadRegion[]> {
  const regions: VadRegion[] = [];
  const frameCount = Math.floor(samples.length / VAD_FRAME_SAMPLES);
  let runStartS: number | null = null;

  for (let f = 0; f < frameCount; f += 1) {
    const frameOffset = f * VAD_FRAME_SAMPLES;
    // Zero-copy view — the model only reads it, and callers pass either a
    // freshly-read PCM chunk or a dedicated decode buffer, never something
    // reused/mutated concurrently.
    const frame = samples.subarray(frameOffset, frameOffset + VAD_FRAME_SAMPLES);
    const input = new Tensor("float32", frame, [1, VAD_FRAME_SAMPLES]);
    const result = (await model({ input, sr: scan.sr, state: scan.state })) as {
      stateN: Tensor;
      output: Tensor;
    };
    scan.state = result.stateN;
    const prob = result.output.data[0] as number;
    const frameStartS = spanStartS + frameOffset / TARGET_SAMPLE_RATE;

    if (prob >= SILERO_SPEECH_THRESHOLD) {
      if (runStartS === null) runStartS = frameStartS;
    } else if (runStartS !== null) {
      regions.push({ start: runStartS, end: frameStartS });
      runStartS = null;
    }
  }
  if (runStartS !== null) {
    regions.push({
      start: runStartS,
      end: spanStartS + (frameCount * VAD_FRAME_SAMPLES) / TARGET_SAMPLE_RATE,
    });
  }
  return regions;
}

/**
 * Turn either Silero's raw regions (preferred) or an energy-gate fallback
 * derived from the full-clip envelope into the final regions to transcribe.
 * `rawRegions === null` means "Silero unavailable/failed" — NOT "Silero
 * found no speech" (that case is `[]`, still passed through as Silero's
 * result, correctly yielding zero final regions).
 */
function finalizeVadRegions(
  rawRegions: VadRegion[] | null,
  audioEnvelope: AudioEnvelope,
  durationS: number,
): VadRegion[] {
  const raw = rawRegions ?? computeEnergyGateRegions(audioEnvelope);
  return processVadRegions(raw, { totalDurationS: durationS, maxRegionS: MACRO_CHUNK_S });
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
 *
 * VAD gating (vadEnabled && !envelopeOnly) reads the PCM in TWO passes: the
 * first (same macro-chunk loop) always computes the full-clip envelope and,
 * if Silero is available, raw speech regions; the second re-reads ONLY the
 * final processed regions (each still <= MACRO_CHUNK_S, so still a single
 * bounded read) and transcribes those. vad:false keeps the original
 * single-pass loop byte-for-byte (one asr call per macro-chunk, interleaved
 * with envelope computation) — no extra PCM re-read, exact current behavior.
 */
async function transcribeFromPcm(
  requestId: string,
  clipId: string,
  pcmKey: string,
  envelopeOnly: boolean | undefined,
  modelKey: WhisperModelId,
  vadEnabled: boolean,
) {
  let reader: PcmScratchReader | null = null;
  try {
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

    // VAD only ever gates an ACTUAL transcription pass: envelopeOnly never
    // runs ASR (nothing to gate), and vad:false must reproduce the pre-VAD
    // behavior exactly.
    const gateVad = vadEnabled && !envelopeOnly;

    let audioDecodeMs = 0;
    let whisperMs = 0;
    let windowS = 0;
    const rms: number[] = [];
    let segments: TranscriptSegment[] = [];
    let speechSecondsS: number | undefined;

    if (!gateVad) {
      // ---- Unchanged since before VAD existed: one asr call per
      // macro-chunk, interleaved with envelope computation in one pass. ----
      const asr = envelopeOnly ? null : await ensureInit("auto", modelKey);

      let offsetSamples = 0;
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
    } else {
      // ---- VAD-gated: phase 1 scans the whole clip (envelope always;
      // Silero raw regions if available); phase 2 finalizes regions; phase
      // 3 re-reads and transcribes ONLY those regions, offsetting each
      // region's whisper-relative segments back to absolute clip time. ----
      const silero = await ensureSileroVad();
      const sileroScan = silero ? createSileroScanState() : null;
      let sileroRawRegions: VadRegion[] | null = silero ? [] : null;

      let offsetSamples = 0;
      while (offsetSamples < reader.sampleCount) {
        const chunkLen = Math.min(MACRO_CHUNK_SAMPLES, reader.sampleCount - offsetSamples);

        const readStart = performance.now();
        const chunkSamples = reader.read(offsetSamples, chunkLen);
        audioDecodeMs += performance.now() - readStart;

        const chunkStartS = offsetSamples / TARGET_SAMPLE_RATE;
        const chunkEnvelope = computeAudioEnvelope(chunkSamples, TARGET_SAMPLE_RATE);
        windowS = chunkEnvelope.windowS;
        rms.push(...chunkEnvelope.rms);

        if (silero && sileroScan && sileroRawRegions) {
          try {
            const chunkRegions = await scanSileroSpan(silero, sileroScan, chunkSamples, chunkStartS);
            sileroRawRegions.push(...chunkRegions);
          } catch (err) {
            // Runtime failure mid-scan (not just load failure): abandon
            // Silero permanently and fall back — the energy gate re-derives
            // regions from the envelope already being computed here, no
            // re-read needed. Partial Silero results so far are discarded
            // rather than spliced with fallback results for the rest.
            vadUnavailable = true;
            warnVadFallback(err);
            sileroRawRegions = null;
          }
        }

        offsetSamples += chunkSamples.length;
      }

      const fullEnvelope: AudioEnvelope = { windowS, rms };
      const finalRegions = finalizeVadRegions(sileroRawRegions, fullEnvelope, durationS);
      speechSecondsS = finalRegions.reduce((sum, r) => sum + (r.end - r.start), 0);

      const asr = await ensureInit("auto", modelKey);
      for (const region of finalRegions) {
        const startSample = Math.max(0, Math.round(region.start * TARGET_SAMPLE_RATE));
        const endSample = Math.min(reader.sampleCount, Math.round(region.end * TARGET_SAMPLE_RATE));
        if (endSample <= startSample) continue;
        const regionSamples = reader.read(startSample, endSample - startSample);
        if (regionSamples.length === 0) continue;
        const regionDurationS = regionSamples.length / TARGET_SAMPLE_RATE;

        const whisperStart = performance.now();
        const result = (await asr(regionSamples, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
        })) as { chunks?: WhisperChunk[] };
        whisperMs += performance.now() - whisperStart;

        const regionSegments: TranscriptSegment[] = [];
        for (const c of result.chunks ?? []) {
          const text = c.text.trim();
          if (!text) continue;
          regionSegments.push({
            t0: c.timestamp[0] ?? 0,
            t1: c.timestamp[1] ?? regionDurationS,
            text,
          });
        }
        // ABSOLUTE clip time: offset by THIS region's own start, never the
        // start of a larger region it may have been split from.
        segments.push(...offsetSegments(regionSegments, region.start));
      }
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
      speechSecondsS,
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
  const modelKey = req.model ?? "base";
  const vadEnabled = req.vad ?? true;

  // PCM sidecar path: the funnel's visual pass already extracted 16k mono
  // f32le audio to OPFS scratch (`<clipId>.audio`). Rolling-window clips
  // delete their video scratch windows as they're consumed, so by
  // transcription time there is no container left for the legacy path
  // below to decode — read the sidecar instead and ignore
  // blob/opfsKey/partial entirely.
  if (pcmKey) {
    await transcribeFromPcm(requestId, clipId, pcmKey, envelopeOnly, modelKey, vadEnabled);
    return;
  }

  let scratchClose: (() => void) | null = null;
  /** Temporary scratch copy made for THIS request (deleted before returning). */
  let tempScratchKey: string | null = null;
  try {
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

    // Past this point envelopeOnly is always false — a cache backfill pass
    // returns above without ever touching the ASR pipeline (no wait on, or
    // trigger of, a model download) or the VAD gate (nothing to gate).
    let whisperMs = 0;
    let segments: TranscriptSegment[] = [];
    let speechSecondsS: number | undefined;

    if (!vadEnabled) {
      // ---- Exact current behavior: one asr call over the whole buffer. ----
      const asr = await ensureInit("auto", modelKey);
      const whisperStart = performance.now();
      const result = (await asr(decoded.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      })) as { chunks?: WhisperChunk[] };
      whisperMs = performance.now() - whisperStart;

      segments = (result.chunks ?? [])
        .filter((c) => c.text.trim().length > 0)
        .map((c) => ({
          t0: c.timestamp[0] ?? 0,
          t1: c.timestamp[1] ?? decoded.durationS,
          text: c.text.trim(),
        }));
    } else {
      // ---- VAD-gated: the whole clip is already decoded in memory, so
      // Silero scans it in one span (spanStartS 0); regions are then sliced
      // straight out of decoded.audio, no re-decode needed. ----
      const silero = await ensureSileroVad();
      let rawRegions: VadRegion[] | null = null;
      if (silero) {
        try {
          rawRegions = await scanSileroSpan(silero, createSileroScanState(), decoded.audio, 0);
        } catch (err) {
          vadUnavailable = true;
          warnVadFallback(err);
          rawRegions = null;
        }
      }

      const finalRegions = finalizeVadRegions(rawRegions, audioEnvelope, decoded.durationS);
      speechSecondsS = finalRegions.reduce((sum, r) => sum + (r.end - r.start), 0);

      const asr = await ensureInit("auto", modelKey);
      for (const region of finalRegions) {
        const startSample = Math.max(0, Math.round(region.start * TARGET_SAMPLE_RATE));
        const endSample = Math.min(decoded.audio.length, Math.round(region.end * TARGET_SAMPLE_RATE));
        if (endSample <= startSample) continue;
        const regionSamples = decoded.audio.subarray(startSample, endSample);
        const regionDurationS = regionSamples.length / TARGET_SAMPLE_RATE;

        const whisperStart = performance.now();
        const result = (await asr(regionSamples, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
        })) as { chunks?: WhisperChunk[] };
        whisperMs += performance.now() - whisperStart;

        const regionSegments: TranscriptSegment[] = (result.chunks ?? [])
          .filter((c) => c.text.trim().length > 0)
          .map((c) => ({
            t0: c.timestamp[0] ?? 0,
            t1: c.timestamp[1] ?? regionDurationS,
            text: c.text.trim(),
          }));
        segments.push(...offsetSegments(regionSegments, region.start));
      }
    }

    post({
      type: "segments",
      requestId,
      clipId,
      segments,
      perf: { audioDecodeMs, whisperMs, audioDurationS: decoded.durationS },
      audioEnvelope,
      audioEvents,
      speechSecondsS,
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
    // Eager warm-up always loads "base" — the per-request `model` choice
    // only exists on "transcribe" messages, which aren't known yet at
    // worker-creation time. A later transcribe request for
    // "large-v3-turbo" reloads via ensureInit, serialized through
    // modelChain so this can never race into two resident pipelines.
    ensureInit(msg.device, "base").catch((err) => {
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
