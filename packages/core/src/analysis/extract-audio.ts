/**
 * Decode a file's (or blob's) audio track to 16kHz mono float32 PCM, on the
 * CALLING thread — no worker spun up here. This is the main-thread
 * counterpart to decodeAudioTo16kMono in workers/whisper-worker.ts: same
 * mediabunny primitives (Input + AudioSampleSink), same downmix-then-resample
 * order, same StreamingResampler — so cloud transcription (which calls this
 * from the perception lab hook) and local whisper transcription decode
 * IDENTICAL audio from the same source file.
 *
 * Reads through mediabunny's BlobSource — the "normal" source for a Blob/File
 * (a File IS a Blob) — which internally opens ONE `blob.slice(pos).stream()`
 * sequential reader per contiguous run and only re-slices when a read lands
 * outside the currently-streamed region (container box lookups; see
 * mediabunny's ReadOrchestrator in its source.ts). This is the SAME primitive
 * the funnel/whisper workers already use for their own "no OPFS scratch
 * available" blob-fallback path (see SAFE_BLOB_READ_MAX_BYTES in
 * workers/opfs-scratch.ts) — never a hand-rolled loop of ad-hoc
 * blob.slice(a,b) reads scattered across the file, which is the pattern that
 * leaks browser-process memory roughly proportional to bytes served and
 * crashed all of Chrome on a 17GB file (see opfs-scratch.ts's module doc).
 * The OPFS-scratch route those workers fall back to for multi-GB files needs
 * FileSystemSyncAccessHandle, a dedicated-worker-only API — unavailable here
 * by design, since this helper is specified to run on the calling thread.
 */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import { StreamingResampler } from "./audio-resample";

const TARGET_SAMPLE_RATE_HZ = 16000;

export interface ExtractAudioPcmOptions {
  signal?: AbortSignal;
  /** Called with fraction-done (0..1) as samples stream in. Best-effort. */
  onProgress?: (fracDone: number) => void;
}

function checkAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

/**
 * Decodes `file`'s primary audio track to mono 16kHz Float32Array. Resolves
 * null when the file has no audio track. Streaming: each AudioSample is
 * downmixed and (if needed) resampled immediately, then released — peak
 * memory is the OUTPUT PCM only (~230MB for a 1-hour clip, acceptable), never
 * the whole decoded track buffered some other way, and never the compressed
 * source file materialized in memory either (BlobSource streams it in
 * bounded, cached chunks).
 */
export async function extractAudioPcm(
  file: File | Blob,
  opts: ExtractAudioPcmOptions = {},
): Promise<Float32Array | null> {
  const input = new Input({
    source: new BlobSource(file, { maxCacheSize: 64 * 2 ** 20 }),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    checkAborted(opts.signal);

    // Best-effort: used only to report progress fractions. A container that
    // can't report a duration just means progress stays unreported —
    // decoding correctness is unaffected either way.
    let durationS = 0;
    try {
      durationS = await input.computeDuration();
    } catch {
      durationS = 0;
    }

    const sink = new AudioSampleSink(track);
    let resampler: StreamingResampler | null = null;
    let passthrough: Float32Array[] | null = null;
    let sourceRate = 0;
    let totalFrames = 0;
    let interleaved = new Float32Array(0);

    for await (const sample of sink.samples()) {
      checkAborted(opts.signal);

      sourceRate = sample.sampleRate;
      const channels = sample.numberOfChannels;
      const frames = sample.numberOfFrames;
      if (interleaved.length < frames * channels) {
        interleaved = new Float32Array(frames * channels);
      }
      sample.copyTo(interleaved, { planeIndex: 0, format: "f32" });
      const timestamp = sample.timestamp;
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

      if (sourceRate === TARGET_SAMPLE_RATE_HZ) {
        (passthrough ??= []).push(mono);
      } else {
        (resampler ??= new StreamingResampler(sourceRate / TARGET_SAMPLE_RATE_HZ)).push(mono);
      }

      if (durationS > 0) opts.onProgress?.(Math.min(1, Math.max(0, timestamp / durationS)));
    }

    if (totalFrames === 0 || sourceRate === 0) return null;

    let result: Float32Array;
    if (passthrough) {
      result = new Float32Array(totalFrames);
      let offset = 0;
      for (const chunk of passthrough) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      result = resampler!.finish();
    }
    opts.onProgress?.(1);
    return result;
  } finally {
    input.dispose();
  }
}
