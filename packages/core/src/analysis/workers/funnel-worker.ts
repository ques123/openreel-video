/**
 * Funnel worker: decodes a clip ONCE (forward scan at a sampled fps,
 * downscaled), computes classical metrics per sampled frame, detects shot
 * boundaries, and streams finalized shots (thumbnail JPEG + raw RGBA rep
 * frame pixels) back to the main thread.
 *
 * IMPORTANT: bundled via `new Worker(new URL(...), { type: "module" })` so
 * that mediabunny resolves through the app's Vite graph (the blob-URL worker
 * pattern in video/decode-worker.ts cannot resolve bare imports and silently
 * falls back to a CDN — do not copy it).
 */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import {
  availableQuota,
  clearScratch,
  copyBlobToScratch,
  copyRangeToScratch,
  deleteScratch,
  openPartialScratchSource,
  openScratchSource,
  type PartialScratchMeta,
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
  const { requestId, clipId, blob, sampleFps, targetWidth } = req;
  const startMs = performance.now();
  let input: Input | null = null;
  let scratch: ScratchReader | null = null;
  let usedOpfs = false;
  let ingestMs = 0;

  let partial: PartialScratchMeta | null = null;

  try {
    // Ingest: stream-copy the dropped File into OPFS scratch (sequential
    // streamed blob reads are leak-free; random-access blob slices leak
    // browser-process memory and eventually crash all of Chrome — verified
    // empirically with 17GB files). All decode reads then go via sync
    // access handles. When the file exceeds available quota, ingest the
    // prefix that fits plus the file tail (MP4 moov index usually lives at
    // the end) and analyze only the covered range. NEVER fall back to
    // random-access blob reads for large files.
    const TAIL_BYTES = 64 * 2 ** 20;
    const QUOTA_SAFETY = 512 * 2 ** 20;
    const MIN_PARTIAL_PREFIX = 1 * 2 ** 30;
    const avail = await availableQuota();
    const budget = avail === null ? Infinity : Math.max(0, avail - QUOTA_SAFETY);

    const onIngestProgress = (bytesDone: number, bytesTotal: number) =>
      post({ type: "ingest-progress", requestId, clipId, bytesDone, bytesTotal });
    const shouldCancel = () => cancelledClips.has(clipId);

    const ingestStart = performance.now();
    try {
      if (blob.size <= budget) {
        await copyBlobToScratch(blob, clipId, onIngestProgress, shouldCancel);
        usedOpfs = true;
      } else if (budget >= MIN_PARTIAL_PREFIX + TAIL_BYTES) {
        const prefixBytes = Math.floor(budget - TAIL_BYTES);
        const tailStart = blob.size - TAIL_BYTES;
        console.warn(
          `[perception] partial ingest: file ${(blob.size / 1e9).toFixed(1)}GB > quota budget ` +
            `${(budget / 1e9).toFixed(1)}GB — analyzing first ${(prefixBytes / 1e9).toFixed(1)}GB`,
        );
        await copyRangeToScratch(blob, clipId, 0, prefixBytes, onIngestProgress, shouldCancel);
        await copyRangeToScratch(blob, `${clipId}.tail`, tailStart, blob.size, undefined, shouldCancel);
        partial = { totalSize: blob.size, prefixBytes, tailStart };
        usedOpfs = true;
      } else {
        throw new Error(
          `not enough browser storage quota to analyze this file (` +
            `${(blob.size / 1e9).toFixed(1)}GB file, ${(budget / 1e9).toFixed(1)}GB quota available)`,
        );
      }
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
    ingestMs = performance.now() - ingestStart;

    if (partial) {
      scratch = await openPartialScratchSource(clipId, partial);
    } else if (usedOpfs) {
      scratch = await openScratchSource(clipId);
    }
    input = new Input({
      source: scratch
        ? scratch.source
        : new BlobSource(blob, { maxCacheSize: 64 * 2 ** 20 }),
      formats: ALL_FORMATS,
    });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track found");

    const durationS = await input.computeDuration();
    const width = track.displayWidth;
    const height = track.displayHeight;
    // Partial ingest: only the byte prefix is available, so cap analysis to
    // the corresponding time range (mdat dominates the file, so byte
    // fraction ≈ time fraction; 0.97 margin keeps reads off the edge).
    const analyzedThroughS = partial
      ? durationS * (partial.prefixBytes / partial.totalSize) * 0.97
      : null;
    post({ type: "meta", requestId, clipId, durationS, width, height, analyzedThroughS });

    const sink = new CanvasSink(track, { width: targetWidth, poolSize: 2 });
    const effectiveDurationS = analyzedThroughS ?? durationS;
    const frameCount = Math.max(1, Math.floor(effectiveDurationS * sampleFps));
    const timestamps = Array.from({ length: frameCount }, (_, i) => i / sampleFps);

    // Pass 1 state: metrics per sampled frame + retained pixel copies.
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

    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
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

      const i = samples.length;
      samples.push({
        t: wrapped.timestamp,
        histDist: prevHist ? histDistance(prevHist, hist) : 0,
        motionDiff: prevGray ? lumaDiff(prevGray, gray) : 0,
        sharpness: laplacianVariance(gray, img.width, img.height),
      });
      retained.set(i, { t: wrapped.timestamp, rgba: img.data, width: img.width, height: img.height });

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
              sharpness: samples[i].sharpness,
            },
            [jpeg],
          );
        }
      }

      // Keepers: spaced snapshots for multi-frame shot embeddings.
      if (i >= nextKeepAt) {
        keepers.set(i, { t: wrapped.timestamp, rgba: img.data, width: img.width, height: img.height });
        nextKeepAt = i + keepStride;
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
      if (i >= 1) {
        const boundaries = detectBoundaries(
          samples.slice(Math.max(0, i - FUNNEL_DEFAULTS.boundaryWindow - 1), i + 1),
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
          Math.max(0, i - FUNNEL_DEFAULTS.boundaryWindow - 1) + lastLocal === i;
        if (
          boundaryHere &&
          samples[i].t - samples[shotStartIndex].t >= FUNNEL_DEFAULTS.minShotLengthS
        ) {
          await finalizeShot(shotStartIndex, i, samples[i].t);
          shotStartIndex = i;
        }
      }

      const now = performance.now();
      if (now - lastProgressPost > 200) {
        lastProgressPost = now;
        post({ type: "progress", requestId, clipId, t: wrapped.timestamp, framesDone });
      }
    }

    // Close the final shot.
    if (samples.length > shotStartIndex) {
      await finalizeShot(shotStartIndex, samples.length, effectiveDurationS);
    }

    // Release the input + exclusive sync-access lock BEFORE announcing done —
    // the orchestrator reacts to "done" by starting the whisper pass, which
    // opens its own handle on the same scratch file.
    input.dispose();
    input = null;
    scratch?.close();

    post({
      type: "done",
      requestId,
      clipId,
      usedOpfs,
      partial,
      analyzedThroughS,
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
    // Release the exclusive sync-access lock BEFORE the whisper pass opens
    // the same scratch file.
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
