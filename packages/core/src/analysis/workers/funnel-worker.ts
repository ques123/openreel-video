/**
 * Funnel worker: decodes a clip ONCE (forward scan at a sampled fps,
 * downscaled), computes classical metrics per sampled frame, detects shot
 * boundaries, and streams finalized shots (thumbnail JPEG + raw RGBA rep
 * frame pixels) back to the main thread.
 *
 * Long clips are ingested in ROLLING WINDOWS instead of one full OPFS copy:
 * a bounded byte window is copied in, scanned, and deleted before the next
 * window is copied, so a 30-60min/20-45GB clip gets FULL coverage inside a
 * bounded scratch footprint instead of being truncated to whatever fits. A
 * 16k mono PCM sidecar is extracted alongside the video scan so the whisper
 * pass never needs the (by-then-deleted) video windows.
 *
 * IMPORTANT: bundled via `new Worker(new URL(...), { type: "module" })` so
 * that mediabunny resolves through the app's Vite graph (the blob-URL worker
 * pattern in video/decode-worker.ts cannot resolve bare imports and silently
 * falls back to a CDN — do not copy it).
 */

import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input } from "mediabunny";
import {
  appendPcmToScratch,
  availableQuota,
  clearScratch,
  copyBlobToScratch,
  copyRangeToScratch,
  deleteScratch,
  deleteScratchEntry,
  MIN_WINDOW_BYTES,
  openScratchSource,
  openWindowScratchSource,
  planIngestWindows,
  WINDOW_HEAD_BYTES,
  WINDOW_OVERLAP_BYTES,
  WINDOW_TAIL_BYTES,
  type ScratchReader,
} from "./opfs-scratch";
import {
  detectBoundaries,
  hsvHistogram,
  histDistance,
  laplacianVariance,
  lumaDiff,
  summarizeShots,
  toGrayscale,
  type FrameSample,
} from "../shot-metrics";
import { FUNNEL_DEFAULTS } from "../types";
import type {
  FunnelRequest,
  FunnelResponse,
  FunnelShotResponse,
} from "../worker-protocol";
import { StreamingResampler } from "../audio-resample";

const cancelledClips = new Set<string>();

function post(message: FunnelResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(message, { transfer: transfer ?? [] });
}

interface RetainedFrame {
  t: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

async function encodeJpeg(frame: RetainedFrame, quality: number): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create 2d context for thumbnail");
  ctx.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return blob.arrayBuffer();
}

async function analyze(req: Extract<FunnelRequest, { type: "analyze" }>) {
  const { requestId, clipId, blob, sampleFps, targetWidth, debugIngestBudgetBytes } = req;
  const startMs = performance.now();
  let input: Input | null = null;
  let scratch: ScratchReader | null = null;
  let usedOpfs = false;
  let ingestMs = 0;

  try {
    // Ingest: stream-copy the dropped File into OPFS scratch in ROLLING
    // WINDOWS (sequential streamed blob reads are leak-free; random-access
    // blob slices leak browser-process memory and eventually crash all of
    // Chrome — verified empirically with 17GB files). A small head + tail
    // (the container boxes: ftyp/moov at front or back) are kept resident
    // for the whole run; the big "current window" file rotates — copied,
    // scanned, deleted, next window copied — so total OPFS footprint stays
    // bounded regardless of source file size while every byte still gets
    // analyzed. NEVER fall back to random-access blob reads for large files.
    const QUOTA_SAFETY = 512 * 2 ** 20;
    const avail = await availableQuota();
    const budget =
      debugIngestBudgetBytes ?? (avail === null ? Infinity : Math.max(0, avail - QUOTA_SAFETY));

    // TEST HOOK: debugIngestBudgetBytes also scales down the head/tail/
    // overlap/min-window geometry. Without this, a tiny debug budget could
    // never satisfy the (production-sized, GB-scale) MIN_WINDOW_BYTES floor
    // and would just fail with a quota error instead of exercising the
    // multi-window path on a small fixture. Real runs (no debug hook) pass
    // no opts, so production geometry/behavior is unchanged.
    const debugOpts =
      debugIngestBudgetBytes !== undefined
        ? {
            headBytes: Math.min(WINDOW_HEAD_BYTES, Math.floor(debugIngestBudgetBytes / 8)),
            tailBytes: Math.min(WINDOW_TAIL_BYTES, Math.floor(debugIngestBudgetBytes / 8)),
            overlapBytes: Math.min(WINDOW_OVERLAP_BYTES, Math.floor(debugIngestBudgetBytes / 8)),
            minWindowBytes: Math.min(MIN_WINDOW_BYTES, Math.floor(debugIngestBudgetBytes / 4)),
          }
        : undefined;

    const plan = planIngestWindows(blob.size, budget, debugOpts);
    if (plan === null) {
      throw new Error(
        `not enough browser storage quota to analyze this file (` +
          `${(blob.size / 1e9).toFixed(1)}GB file, ${(budget / 1e9).toFixed(1)}GB quota available)`,
      );
    }

    const onIngestProgress = (bytesDone: number, bytesTotal: number) =>
      post({ type: "ingest-progress", requestId, clipId, bytesDone, bytesTotal });
    const shouldCancel = () => cancelledClips.has(clipId);

    // A single entry with headBytes 0 means the whole file fits in one
    // scratch copy — the pre-window degenerate case. It's unified into the
    // window loop below as a single iteration with no head/tail files and
    // no window deletion.
    const singleWindow = plan.windows.length === 1 && plan.headBytes === 0;

    try {
      const ingestStart = performance.now();
      if (singleWindow) {
        await copyBlobToScratch(blob, clipId, onIngestProgress, shouldCancel);
      } else {
        // Head/tail are small and live for the whole run — no progress
        // reporting for them, only for the (large) rotating window copies.
        await copyRangeToScratch(blob, `${clipId}.head`, 0, plan.headBytes, undefined, shouldCancel);
        await copyRangeToScratch(
          blob,
          `${clipId}.tail`,
          blob.size - plan.tailBytes,
          blob.size,
          undefined,
          shouldCancel,
        );
      }
      ingestMs += performance.now() - ingestStart;
      usedOpfs = true;
    } catch (err) {
      await deleteScratch(clipId);
      if (err instanceof Error && err.message === "cancelled") throw err;
      // Only harmless small files may use direct blob reads as a fallback.
      if (blob.size <= 512 * 2 ** 20) {
        console.warn("[perception] OPFS ingest failed, small-file blob fallback:", err);
      } else {
        throw err;
      }
    }

    // Unify all three ingest modes (multi-window OPFS / single-window OPFS /
    // blob fallback) into one window list, so everything from here down is
    // oblivious to which mode produced it.
    const multiWindow = usedOpfs && !singleWindow;
    const windows = multiWindow ? plan.windows : [{ startByte: 0, endByte: blob.size }];
    const W = windows.length;
    const headBytes = multiWindow ? plan.headBytes : 0;
    const tailBytes = multiWindow ? plan.tailBytes : 0;
    const totalSize = blob.size;

    let durationS = 0;
    let width = 0;
    let height = 0;
    let tStart = 0; // seconds fully covered by completed windows so far

    // ---- Pass-1 state, PERSISTENT ACROSS WINDOWS -------------------------
    // Hoisted above the window loop (instead of being reset per window) so a
    // shot that spans a window boundary is finalized exactly as if the whole
    // clip had been decoded in one pass. Everything from here down to
    // finalizeShot is unaware the window loop exists.
    //
    // At 512px wide (~512x288 RGBA = ~590KB/frame) full retention is out of
    // the question. We retain a bounded window: since shots are finalized as
    // soon as the NEXT boundary fires, we only need frames since the last
    // boundary. We cap retention and degrade gracefully by dropping the
    // oldest non-candidate frames if a single shot runs very long.
    const samples: FrameSample[] = [];
    const retained = new Map<number, RetainedFrame>(); // sample index -> frame
    const MAX_RETAINED = 120; // ~20s of shot at 6fps, ~70MB worst case at 512px

    // "Keepers": spaced snapshots across the CURRENT shot so long shots get
    // several embedding frames (retained only covers the trailing window).
    // Capped by thinning: on overflow drop every 2nd keeper, double stride.
    const keepers = new Map<number, RetainedFrame>();
    const BASE_KEEP_STRIDE = Math.max(1, Math.round(FUNNEL_DEFAULTS.embedFrameEveryS * sampleFps));
    const MAX_KEEPERS = 48;
    let keepStride = BASE_KEEP_STRIDE;
    let nextKeepAt = 0;

    let prevHist: Float32Array | null = null;
    let prevGray: Uint8Array | null = null;
    // Adaptive dense sampler state: last KEPT frame's histogram + time.
    let nextDenseAt = 0;
    let lastDenseHist: Float32Array | null = null;
    let lastDenseT = -Infinity;
    let framesDone = 0;
    let shotStartIndex = 0;
    let shotIndex = 0;
    let lastProgressPost = 0;

    // Audio sidecar state, also persistent across windows.
    let hasAudio = true; // window 0 decides for real below; failures flip it false
    let appendedTotalSamples = 0; // running 16k-domain total — avoids float drift

    const finalizeShot = async (
      iStart: number,
      iEnd: number,
      tEnd: number,
    ): Promise<void> => {
      const slice = samples.slice(iStart, iEnd);
      // Reuse summarizeShots on the slice (single shot: no boundaries).
      const [summary] = summarizeShots(slice, [], tEnd, FUNNEL_DEFAULTS.repFramePeakRadiusS);
      if (!summary) return;
      const repAbsIndex = iStart + summary.repIndex;
      const rep = retained.get(repAbsIndex) ?? retained.get(iStart) ?? keepers.get(iStart);
      if (!rep) return; // all candidate frames evicted (pathological)

      const thumbJpeg = await encodeJpeg(rep, FUNNEL_DEFAULTS.thumbnailQuality);

      // frames[0] = rep; then up to maxEmbedFramesPerShot-1 keepers spread
      // across the shot (skip ones within a stride of the rep frame).
      const extraIndexes = [...keepers.keys()]
        .filter((k) => k >= iStart && k < iEnd && Math.abs(k - repAbsIndex) > BASE_KEEP_STRIDE / 2)
        .sort((a, b) => a - b);
      const maxExtras = FUNNEL_DEFAULTS.maxEmbedFramesPerShot - 1;
      const step = Math.max(1, Math.ceil(extraIndexes.length / maxExtras));
      const chosen = extraIndexes.filter((_, idx) => idx % step === 0).slice(0, maxExtras);

      const frames = [rep, ...chosen.map((k) => keepers.get(k)!)].map((f) => ({
        data: f.rgba.buffer.slice(0) as ArrayBuffer,
        width: f.width,
        height: f.height,
      }));

      const message: FunnelShotResponse = {
        type: "shot",
        requestId,
        clipId,
        shot: {
          index: shotIndex,
          tStart: samples[iStart].t,
          tEnd,
          repFrameTime: samples[repAbsIndex]?.t ?? samples[iStart].t,
          motion: { score: summary.motionScore, peakTime: summary.motionPeakTime },
          quality: { sharpness: summary.repSharpness },
        },
        thumbJpeg,
        frames,
      };
      post(message, [thumbJpeg, ...frames.map((f) => f.data)]);
      shotIndex += 1;

      // Free everything belonging to the finalized shot.
      for (let i = iStart; i < iEnd; i += 1) retained.delete(i);
      for (const k of [...keepers.keys()]) {
        if (k >= iStart && k < iEnd) keepers.delete(k);
      }
      keepStride = BASE_KEEP_STRIDE;
      nextKeepAt = iEnd;
    };

    // ---- Window loop: ingest -> scan (+ extract audio) -> delete -> repeat
    for (let i = 0; i < W; i += 1) {
      if (cancelledClips.has(clipId)) {
        cancelledClips.delete(clipId);
        post({ type: "error", requestId, clipId, message: "cancelled" });
        return;
      }

      const { startByte, endByte } = windows[i];

      if (W > 1) {
        post({
          type: "window",
          requestId,
          clipId,
          window: i + 1,
          windows: W,
          analyzedThroughS: tStart,
        });
      }

      if (multiWindow) {
        const windowIngestStart = performance.now();
        await copyRangeToScratch(blob, clipId, startByte, endByte, onIngestProgress, shouldCancel);
        ingestMs += performance.now() - windowIngestStart;
        scratch = await openWindowScratchSource(clipId, {
          totalSize,
          headBytes,
          windowStart: startByte,
          windowBytes: endByte - startByte,
          tailStart: totalSize - tailBytes,
        });
      } else if (usedOpfs) {
        scratch = await openScratchSource(clipId);
      }
      // else: blob fallback — scratch stays null, BlobSource is used below.

      input = new Input({
        source: scratch ? scratch.source : new BlobSource(blob, { maxCacheSize: 64 * 2 ** 20 }),
        formats: ALL_FORMATS,
      });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("No video track found");

      if (i === 0) {
        durationS = await input.computeDuration();
        width = track.displayWidth;
        height = track.displayHeight;
        // Full coverage is the plan now — no byte-fraction analyzedThroughS cap.
        post({ type: "meta", requestId, clipId, durationS, width, height, analyzedThroughS: null });
      }

      // The last window always covers to the TRUE end (its bytes reach
      // totalSize, so the exact duration is safe to use); earlier windows
      // use a 0.97 margin off their end byte's estimated time so no read
      // lands past the ingested edge (byte fraction ≈ time fraction — mdat
      // dominates file size). EDGE CASE: an undeterminable/zero durationS
      // degrades exactly as it always has here — no timestamp satisfies the
      // grid below, no frames get sampled, no shots are finalized, and
      // "done" reports zero frames rather than throwing a new error.
      const coverageEnd = i === W - 1 ? durationS : durationS * (endByte / totalSize) * 0.97;

      // Globally-indexed sample grid (t = k / sampleFps for integer k) so
      // consecutive windows tile seamlessly: this window starts at the first
      // grid point >= tStart (== coverageEnd of the PREVIOUS window, or 0 for
      // the first window) and stops just short of its own coverageEnd — no
      // duplicated and no skipped frame at the seam.
      // EDGE CASE: extreme window overlap or a tiny final window can make
      // coverageEnd <= tStart, yielding an empty array here. That's fine —
      // the for-await below is then a no-op; audio extraction and window
      // teardown still run further down.
      const windowTimestamps: number[] = [];
      for (let k = Math.ceil(tStart * sampleFps); k / sampleFps < coverageEnd; k += 1) {
        windowTimestamps.push(k / sampleFps);
      }

      const sink = new CanvasSink(track, { width: targetWidth, poolSize: 2 });
      for await (const wrapped of sink.canvasesAtTimestamps(windowTimestamps)) {
        if (cancelledClips.has(clipId)) {
          cancelledClips.delete(clipId);
          post({ type: "error", requestId, clipId, message: "cancelled" });
          return;
        }
        if (!wrapped) {
          framesDone += 1;
          continue;
        }

        const canvas = wrapped.canvas as OffscreenCanvas;
        const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
        if (!ctx) throw new Error("No 2d context on decoded canvas");
        // Copy pixels out of the pooled canvas BEFORE the next iteration reuses it.
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const gray = toGrayscale(img.data, img.width, img.height);
        const hist = hsvHistogram(img.data, img.width, img.height);

        const si = samples.length;
        samples.push({
          t: wrapped.timestamp,
          histDist: prevHist ? histDistance(prevHist, hist) : 0,
          motionDiff: prevGray ? lumaDiff(prevGray, gray) : 0,
          sharpness: laplacianVariance(gray, img.width, img.height),
        });
        retained.set(si, { t: wrapped.timestamp, rgba: img.data, width: img.width, height: img.height });

        // Dense caption frames, adaptively sampled: consider a frame at most
        // every denseCaptionEveryS, but KEEP it only when the scene visibly
        // changed since the last kept frame (hist distance) or a max gap
        // elapsed. Static takes cost a frame per maxGap; every real scene
        // change still lands its own frame.
        if (wrapped.timestamp >= nextDenseAt) {
          nextDenseAt = wrapped.timestamp + FUNNEL_DEFAULTS.denseCaptionEveryS;
          const changed =
            lastDenseHist === null ||
            histDistance(lastDenseHist, hist) > FUNNEL_DEFAULTS.denseCaptionMinDelta ||
            wrapped.timestamp - lastDenseT >= FUNNEL_DEFAULTS.denseCaptionMaxGapS;
          if (changed) {
            lastDenseHist = hist;
            lastDenseT = wrapped.timestamp;
            const jpeg = await encodeJpeg(
              { t: wrapped.timestamp, rgba: img.data, width: img.width, height: img.height },
              FUNNEL_DEFAULTS.denseFrameQuality,
            );
            post(
              {
                type: "dense-frame",
                requestId,
                clipId,
                t: wrapped.timestamp,
                jpeg,
                sharpness: samples[si].sharpness,
              },
              [jpeg],
            );
          }
        }

        // Keepers: spaced snapshots for multi-frame shot embeddings.
        if (si >= nextKeepAt) {
          keepers.set(si, { t: wrapped.timestamp, rgba: img.data, width: img.width, height: img.height });
          nextKeepAt = si + keepStride;
          if (keepers.size > MAX_KEEPERS) {
            let odd = false;
            for (const k of [...keepers.keys()].sort((a, b) => a - b)) {
              if (odd) keepers.delete(k);
              odd = !odd;
            }
            keepStride *= 2;
          }
        }

        // Bound retention: evict oldest frames of the current (long) shot,
        // but never the first frame (fallback rep).
        if (retained.size > MAX_RETAINED) {
          for (const key of retained.keys()) {
            if (key !== shotStartIndex) {
              retained.delete(key);
              break;
            }
          }
        }

        prevHist = hist;
        prevGray = gray;
        framesDone += 1;

        // Adaptive boundary check on the tail (cheap: only needs the window).
        if (si >= 1) {
          const boundaries = detectBoundaries(
            samples.slice(Math.max(0, si - FUNNEL_DEFAULTS.boundaryWindow - 1), si + 1),
            {
              absFloor: FUNNEL_DEFAULTS.boundaryAbsFloor,
              k: FUNNEL_DEFAULTS.boundaryK,
              window: FUNNEL_DEFAULTS.boundaryWindow,
              minShotLengthS: 0, // min length enforced against shotStartIndex below
            },
          );
          const lastLocal = boundaries.length > 0 ? boundaries[boundaries.length - 1] : -1;
          const boundaryHere =
            lastLocal >= 0 &&
            Math.max(0, si - FUNNEL_DEFAULTS.boundaryWindow - 1) + lastLocal === si;
          if (
            boundaryHere &&
            samples[si].t - samples[shotStartIndex].t >= FUNNEL_DEFAULTS.minShotLengthS
          ) {
            await finalizeShot(shotStartIndex, si, samples[si].t);
            shotStartIndex = si;
          }
        }

        const now = performance.now();
        if (now - lastProgressPost > 200) {
          lastProgressPost = now;
          post({ type: "progress", requestId, clipId, t: wrapped.timestamp, framesDone });
        }
      }

      // ---- Audio sidecar: same Input, right after the video scan while
      // this window's bytes are still around. A failure here must NOT kill
      // the visual analysis that just succeeded for this window.
      if (hasAudio) {
        try {
          const audioTrack = await input.getPrimaryAudioTrack();
          if (i === 0) hasAudio = audioTrack !== null; // window 0 decides, for good
          if (hasAudio && audioTrack) {
            const audioFromS = appendedTotalSamples / 16000; // 16k-domain cursor, no drift
            const audioToS = i === W - 1 ? undefined : coverageEnd; // last window reads to EOF
            const audioSink = new AudioSampleSink(audioTrack);
            let windowResampler: StreamingResampler | null = null;
            let windowPassthrough: Float32Array[] | null = null;
            let interleaved = new Float32Array(0);

            for await (const sample of audioSink.samples(audioFromS, audioToS)) {
              const channels = sample.numberOfChannels;
              const frames = sample.numberOfFrames;
              if (interleaved.length < frames * channels) {
                interleaved = new Float32Array(frames * channels);
              }
              sample.copyTo(interleaved, { planeIndex: 0, format: "f32" });
              const sourceRate = sample.sampleRate;
              const timestamp = sample.timestamp;
              sample.close();

              // Windows overlap in byte-space, so the first sample handed
              // back can straddle our append cursor — trim the leading
              // frames already covered by the previous window's append.
              const skip = Math.max(0, Math.round((audioFromS - timestamp) * sourceRate));
              const usable = skip < frames ? frames - skip : 0;
              if (usable === 0) continue;

              const mono = new Float32Array(usable);
              if (channels === 1) {
                mono.set(interleaved.subarray(skip, skip + usable));
              } else {
                for (let f = 0; f < usable; f += 1) {
                  let sum = 0;
                  const base = (f + skip) * channels;
                  for (let c = 0; c < channels; c += 1) sum += interleaved[base + c];
                  mono[f] = sum / channels;
                }
              }

              if (sourceRate === 16000) {
                (windowPassthrough ??= []).push(mono);
              } else {
                (windowResampler ??= new StreamingResampler(sourceRate / 16000)).push(mono);
              }
            }

            let chunk: Float32Array | null = null;
            if (windowPassthrough) {
              const total = windowPassthrough.reduce((sum, c) => sum + c.length, 0);
              chunk = new Float32Array(total);
              let offset = 0;
              for (const c of windowPassthrough) {
                chunk.set(c, offset);
                offset += c.length;
              }
            } else if (windowResampler) {
              chunk = windowResampler.finish();
            }

            if (chunk && chunk.length > 0) {
              await appendPcmToScratch(`${clipId}.audio`, chunk);
              appendedTotalSamples += chunk.length;
            }
          }
        } catch (err) {
          console.warn(
            `[perception] audio sidecar failed at window ${i + 1}/${W}, disabling audio for the rest of this clip:`,
            err,
          );
          hasAudio = false;
        }
      }

      // ---- Teardown: release this window's exclusive lock before the next
      // window's copy (or before "done", for the last window).
      input.dispose();
      input = null;
      scratch?.close();
      scratch = null;
      if (multiWindow && i < W - 1) {
        await deleteScratchEntry(clipId);
      }

      tStart = coverageEnd;
    }

    // Close the final shot. Full coverage is the plan, so this always runs
    // to the true duration — no more "effective" (partial-ingest) cap.
    if (samples.length > shotStartIndex) {
      await finalizeShot(shotStartIndex, samples.length, durationS);
    }

    // input/scratch for the final window were already released above, BEFORE
    // this point — the orchestrator reacts to "done" by starting the whisper
    // pass, which opens its own handle on the `.audio` scratch key.
    post({
      type: "done",
      requestId,
      clipId,
      usedOpfs,
      partial: null, // rolling windows replace the old prefix+tail partial shape
      analyzedThroughS: null, // always full coverage once the loop completes
      ingestWindows: W,
      audioPcm:
        hasAudio && appendedTotalSamples > 0
          ? { key: `${clipId}.audio`, sampleRate: 16000, durationS: appendedTotalSamples / 16000 }
          : null,
      perf: {
        decodeMs: performance.now() - startMs - ingestMs,
        framesDecoded: framesDone,
        ingestMs,
      },
    });
  } catch (err) {
    post({
      type: "error",
      requestId,
      clipId,
      message: describeError(err),
    });
  } finally {
    // Release the exclusive sync-access lock if an error escaped mid-window
    // (normal completion already released these inside the loop above).
    input?.dispose();
    scratch?.close();
  }
}

/**
 * Preserve the error class name — Chrome surfaces failed *file reads* on
 * dropped Files as `TypeError: network error` (from blob.stream()), which is
 * indistinguishable from a real network problem without the context.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    const hint =
      err.message.toLowerCase().includes("network error") ||
      err.name === "NotReadableError" ||
      err.name === "NotFoundError"
        ? " (the source file became unreadable — was the drive disconnected, or the file moved/modified after dropping it?)"
        : "";
    return `${name}${err.message}${hint}`;
  }
  return String(err);
}

self.onmessage = (event: MessageEvent<FunnelRequest>) => {
  const msg = event.data;
  if (msg.type === "analyze") {
    void analyze(msg);
  } else if (msg.type === "cancel") {
    cancelledClips.add(msg.clipId);
  } else if (msg.type === "init") {
    void clearScratch(); // stale leftovers from crashed sessions
  } else if (msg.type === "cleanup") {
    void deleteScratch(msg.clipId);
  }
};
