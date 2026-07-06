/**
 * FunnelOrchestrator: main-thread coordinator for the perception funnel.
 *
 * Owns the three singleton workers (funnel / embedding / whisper), runs the
 * per-clip pipeline (cache check -> visual + audio passes in parallel ->
 * embeddings streamed as shots finalize -> assemble dossier -> save), and
 * surfaces progress events to the UI.
 */

import {
  createCaptionWorker,
  createEmbeddingWorker,
  createFunnelWorker,
  createWhisperWorker,
} from "./create-workers";
import { cleanCaption } from "./caption-text";
import { BLUR_SHARPNESS_THRESHOLD, BLURRY_FRAME_CAPTION } from "./cloud-vision-plan";
import { DossierCache, ThrottledDossierSaver } from "./dossier-cache";
import {
  DOSSIER_VERSION,
  FUNNEL_DEFAULTS,
  type AudioEnvelope,
  type AudioEvent,
  type ClipDossier,
  type DenseCaption,
  type DenseFrame,
  type DossierPerf,
  type FunnelProgressEvent,
  type InferenceDevice,
  type Shot,
  type TranscriptSegment,
} from "./types";
import type {
  CaptionWorkerResponse,
  EmbedResponse,
  FunnelDoneResponse,
  FunnelResponse,
  WhisperResponse,
} from "./worker-protocol";

export type ProgressListener = (event: FunnelProgressEvent) => void;

/** Max embedding requests in flight (backpressure). */
const MAX_EMBED_IN_FLIGHT = 4;

/** Sync shot captions + request an incremental save every N captioned frames. */
const CAPTION_SAVE_EVERY_FRAMES = 25;
/** Min wall-clock between incremental dossier saves during a caption pass. */
const CAPTION_SAVE_MIN_INTERVAL_MS = 10_000;

/**
 * The dense frames a local caption pass still has to process, in frame
 * order. Resume point first: captions are appended in frame order, so
 * anything at or before the last captioned timestamp is done (failed frames
 * retry). Then the blur gate: frames the cloud pass would skip as too
 * blurry to describe (same threshold) get `blurry: true` — the caller
 * annotates them with BLURRY_FRAME_CAPTION instead of spending ~1.4s of
 * FastVLM on motion smear. Pure; exported for unit tests.
 */
export function planLocalCaptionFrames(
  denseFrames: DenseFrame[],
  denseCaptions: DenseCaption[],
): Array<{ frame: DenseFrame; blurry: boolean }> {
  const lastT =
    denseCaptions.length > 0 ? denseCaptions[denseCaptions.length - 1].t : -Infinity;
  return denseFrames
    .filter((f) => f.t > lastT)
    .map((frame) => ({
      frame,
      blurry: frame.sharpness !== undefined && frame.sharpness < BLUR_SHARPNESS_THRESHOLD,
    }));
}

interface PendingEmbed {
  resolve: (vector: Float32Array, ms: number) => void;
  reject: (err: Error) => void;
}

interface PendingCaption {
  resolve: (caption: string, ms: number) => void;
  reject: (err: Error) => void;
}

interface ClipRun {
  clipId: string;
  /** The file workers DECODE (the .LRF proxy, for proxy pairs). */
  file: File;
  /** The file the dossier is keyed/named by (== file except proxy pairs). */
  identityFile: File;
  shots: Shot[];
  denseFrames: Array<{ t: number; dataUrl: string; sharpness?: number }>;
  transcript: TranscriptSegment[];
  meta: { durationS: number; width: number; height: number } | null;
  startMs: number;
  decodeMs: number;
  framesDecoded: number;
  embedMsTotal: number;
  embedCount: number;
  audioDecodeMs: number;
  whisperMs: number;
  audioDurationS: number;
  /** undefined = whisper response not yet received; null = no audio track. */
  audioEnvelope: AudioEnvelope | null | undefined;
  audioEvents: AudioEvent[] | undefined;
  ingestMs: number;
  usedOpfs: boolean;
  analyzedThroughS: number | null;
  /** How many OPFS ingest windows the visual pass used. 1 = single copy. */
  ingestWindows: number;
  /** 16k mono PCM sidecar the visual pass extracted; null = no audio track or legacy container path. */
  audioPcm: FunnelDoneResponse["audioPcm"];
  /** TEST HOOK forwarded to the funnel worker's "analyze" request (forces the rolling-window path on small fixtures). */
  debugIngestBudgetBytes?: number;
  visualDone: boolean;
  audioDone: boolean;
  embedsInFlight: number;
  embedQueue: Array<() => void>;
  finished: boolean;
  resolve: (dossier: ClipDossier) => void;
  reject: (err: Error) => void;
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

export class FunnelOrchestrator {
  private funnelWorker: Worker | null = null;
  private embeddingWorker: Worker | null = null;
  private whisperWorker: Worker | null = null;
  private captionWorker: Worker | null = null;

  private readonly cache = new DossierCache();
  private readonly listeners = new Set<ProgressListener>();

  private readonly pendingEmbeds = new Map<string, PendingEmbed>();
  private readonly pendingCaptions = new Map<string, PendingCaption>();
  private readonly runsByClipId = new Map<string, ClipRun>();
  /**
   * Cache-hit dossiers awaiting an envelopeOnly enrichment response, keyed
   * by clipId. Separate from runsByClipId because a cache hit never creates
   * a ClipRun (analyzeFile returns before the pipeline runs).
   */
  private readonly pendingAudioEnrichment = new Map<
    string,
    { file: File; dossier: ClipDossier }
  >();

  private embedDevice: InferenceDevice | null = null;
  private whisperDevice: InferenceDevice | null = null;
  private clipModelLoadMs = 0;
  private whisperModelLoadMs = 0;

  /** Serialize visual passes: one clip decodes at a time. */
  private funnelChain: Promise<void> = Promise.resolve();
  /** Serialize caption generation: it's heavy and enrichment is background work. */
  private captionChain: Promise<void> = Promise.resolve();

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: FunnelProgressEvent) {
    for (const listener of this.listeners) listener(event);
  }

  /** Start model downloads early (call on page mount). */
  warmUp(device: "auto" | InferenceDevice = "auto") {
    this.ensureEmbeddingWorker(device);
    this.ensureWhisperWorker(device);
    // FastVLM (~1GB) is by far the biggest download and used to start only
    // after clip 1's full visual+audio pass. Kick it now, fire-and-forget:
    // the worker downloads in parallel and a failure here must never break
    // warmUp (captioning is best-effort enrichment).
    try {
      this.ensureCaptionWorker(device);
    } catch (err) {
      console.warn("[perception] caption worker warm-up failed:", err);
    }
  }

  dispose() {
    this.funnelWorker?.terminate();
    this.embeddingWorker?.terminate();
    this.whisperWorker?.terminate();
    this.captionWorker?.terminate();
    this.funnelWorker = null;
    this.embeddingWorker = null;
    this.whisperWorker = null;
    this.captionWorker = null;
    this.listeners.clear();
    for (const [, pending] of this.pendingEmbeds) {
      pending.reject(new Error("disposed"));
    }
    this.pendingEmbeds.clear();
    for (const [, pending] of this.pendingCaptions) {
      pending.reject(new Error("disposed"));
    }
    this.pendingCaptions.clear();
    this.pendingAudioEnrichment.clear();
    for (const [, run] of this.runsByClipId) {
      if (!run.finished) run.reject(new Error("disposed"));
    }
    this.runsByClipId.clear();
  }

  /**
   * Analyze one file. Resolves with the complete dossier (from cache when
   * available). Progress streams via onProgress listeners. Callers may supply
   * their own clipId so they can correlate progress events with UI rows.
   */
  async analyzeFile(
    file: File,
    device: "auto" | InferenceDevice = "auto",
    clipId: string = uid("clip"),
    opts: {
      /**
       * The clip's IDENTITY file when `file` is a small analysis stand-in
       * (DJI .LRF proxy): cacheKey, fileName and recordedAt come from this;
       * decode reads `file`. Omit for normal clips.
       */
      identityFile?: File;
      /**
       * TEST HOOK: pretend OPFS quota is capped at this many bytes, forcing
       * the rolling-window ingest path on small fixtures. The web layer
       * reads this from localStorage; never set it in production. Forwarded
       * verbatim to the funnel worker's "analyze" request.
       */
      debugIngestBudgetBytes?: number;
    } = {},
  ): Promise<ClipDossier> {
    const identity = opts.identityFile ?? file;
    const cached = await this.cache.load(identity);
    if (cached) {
      const dossier: ClipDossier = {
        ...cached,
        clipId,
        perf: { ...cached.perf, cacheHit: true },
      };
      this.emit({
        kind: "meta",
        clipId,
        durationS: dossier.durationS,
        width: dossier.width,
        height: dossier.height,
        analyzedThroughS: dossier.analyzedThroughS,
      });
      for (const shot of dossier.shots) this.emit({ kind: "shot", clipId, shot });
      this.emit({ kind: "transcript", clipId, segments: dossier.transcript });
      if (dossier.audioEnvelope) {
        this.emit({
          kind: "audio-signals",
          clipId,
          envelope: dossier.audioEnvelope,
          events: dossier.audioEvents ?? [],
        });
      }
      this.emit({ kind: "clip-done", clipId, dossier });
      // Dense frames persist in the dossier, so an interrupted caption pass
      // resumes from where it stopped — no re-decode.
      if (dossier.denseFrames.length > 0) {
        this.captionDense(identity, dossier, device);
      } else {
        this.enrichCaptions(identity, dossier, device);
      }
      // Cached dossiers may predate audio signals entirely (undefined ==
      // never computed) — backfill them without re-running ASR. Decode the
      // file we were handed (the small proxy, for pairs); save under identity.
      this.enrichAudioSignals(file, dossier, device, identity);
      return dossier;
    }

    const run: ClipRun = {
      clipId,
      file,
      identityFile: identity,
      shots: [],
      denseFrames: [],
      transcript: [],
      meta: null,
      startMs: performance.now(),
      decodeMs: 0,
      ingestMs: 0,
      usedOpfs: false,
      analyzedThroughS: null,
      ingestWindows: 1,
      audioPcm: null,
      debugIngestBudgetBytes: opts.debugIngestBudgetBytes,
      framesDecoded: 0,
      embedMsTotal: 0,
      embedCount: 0,
      audioDecodeMs: 0,
      whisperMs: 0,
      audioDurationS: 0,
      audioEnvelope: undefined,
      audioEvents: undefined,
      visualDone: false,
      audioDone: false,
      embedsInFlight: 0,
      embedQueue: [],
      finished: false,
      resolve: () => undefined,
      reject: () => undefined,
    };
    this.runsByClipId.set(clipId, run);

    const promise = new Promise<ClipDossier>((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
    });

    this.ensureEmbeddingWorker(device);
    this.ensureWhisperWorker(device);

    // Visual pass is serialized across clips (decode throughput). The audio
    // pass for a clip starts only AFTER its visual pass finishes: two
    // concurrent readers on the same multi-GB dropped File (sequential video
    // + scattered audio) overwhelm Chrome's browser-process blob machinery —
    // reads start failing with "network error" and the browser can crash.
    this.funnelChain = this.funnelChain.then(
      () => this.runVisualPass(run),
      () => this.runVisualPass(run),
    );

    return promise;
  }

  /** Embed arbitrary text (search queries) into the shared CLIP space. */
  embedText(text: string, device: "auto" | InferenceDevice = "auto"): Promise<Float32Array> {
    this.ensureEmbeddingWorker(device);
    const requestId = uid("text");
    return new Promise<Float32Array>((resolve, reject) => {
      this.pendingEmbeds.set(requestId, {
        resolve: (vector) => resolve(vector),
        reject,
      });
      this.embeddingWorker!.postMessage({ type: "embed-text", requestId, text });
    });
  }

  cancelClip(clipId: string) {
    this.funnelWorker?.postMessage({ type: "cancel", clipId });
  }

  // -------------------------------------------------------------------------

  private runVisualPass(run: ClipRun): Promise<void> {
    return new Promise<void>((resolveVisual) => {
      const worker = this.ensureFunnelWorker();
      const requestId = uid("funnel");

      const handler = (event: MessageEvent<FunnelResponse>) => {
        const msg = event.data;
        if (msg.requestId !== requestId) return;

        switch (msg.type) {
          case "meta":
            run.meta = { durationS: msg.durationS, width: msg.width, height: msg.height };
            run.analyzedThroughS = msg.analyzedThroughS;
            this.emit({
              kind: "meta",
              clipId: run.clipId,
              durationS: msg.durationS,
              width: msg.width,
              height: msg.height,
              analyzedThroughS: msg.analyzedThroughS,
            });
            break;

          case "progress":
            this.emit({
              kind: "decode-progress",
              clipId: run.clipId,
              t: msg.t,
              framesDone: msg.framesDone,
            });
            break;

          case "shot":
            this.handleShot(run, msg.shot, msg.thumbDataUrl, msg.frames);
            break;

          case "dense-frame":
            run.denseFrames.push({
              t: msg.t,
              dataUrl: msg.dataUrl,
              sharpness: msg.sharpness,
            });
            break;

          case "ingest-progress":
            this.emit({
              kind: "ingest-progress",
              clipId: run.clipId,
              bytesDone: msg.bytesDone,
              bytesTotal: msg.bytesTotal,
            });
            break;

          case "window":
            run.ingestWindows = msg.windows;
            this.emit({
              kind: "ingest-window",
              clipId: run.clipId,
              window: msg.window,
              windows: msg.windows,
              analyzedThroughS: msg.analyzedThroughS,
            });
            break;

          case "done":
            run.decodeMs = msg.perf.decodeMs;
            run.ingestMs = msg.perf.ingestMs;
            run.usedOpfs = msg.usedOpfs;
            run.framesDecoded = msg.perf.framesDecoded;
            run.ingestWindows = msg.ingestWindows;
            run.audioPcm = msg.audioPcm;
            run.visualDone = true;
            worker.removeEventListener("message", handler);
            resolveVisual();
            // Start the audio pass now that the funnel worker is done reading
            // this file (whisper worker serializes its own queue).
            if (msg.audioPcm) {
              // Rolling-window clip: the video scratch windows are long gone
              // by now, but the visual pass extracted a 16k mono PCM sidecar
              // for exactly this reason — read that instead of the container.
              this.whisperWorker?.postMessage({
                type: "transcribe",
                requestId: uid("whisper"),
                clipId: run.clipId,
                blob: run.file,
                opfsKey: null,
                partial: null,
                capS: null,
                pcmKey: msg.audioPcm.key,
              });
            } else if (msg.ingestWindows > 1) {
              // Multi-window clip WITHOUT a PCM sidecar = the funnel already
              // proved there is no audio track (or extraction failed). The
              // scratch file now holds only the LAST window's bytes — a
              // container parse of that fragment would be garbage, so send
              // whisper nothing: complete the audio pass as "no audio".
              run.transcript = [];
              run.audioEnvelope = null;
              run.audioEvents = [];
              run.audioDone = true;
              this.emit({ kind: "transcript", clipId: run.clipId, segments: [] });
            } else {
              this.whisperWorker?.postMessage({
                type: "transcribe",
                requestId: uid("whisper"),
                clipId: run.clipId,
                blob: run.file,
                opfsKey: msg.usedOpfs ? run.clipId : null,
                partial: msg.partial,
                capS: msg.analyzedThroughS,
              });
            }
            this.maybeFinish(run);
            break;

          case "error":
            worker.removeEventListener("message", handler);
            resolveVisual();
            this.failRun(run, msg.message);
            break;
        }
      };

      worker.addEventListener("message", handler);
      worker.postMessage({
        type: "analyze",
        requestId,
        clipId: run.clipId,
        blob: run.file,
        sampleFps: FUNNEL_DEFAULTS.sampleFps,
        targetWidth: FUNNEL_DEFAULTS.targetWidth,
        debugIngestBudgetBytes: run.debugIngestBudgetBytes,
      });
    });
  }

  private handleShot(
    run: ClipRun,
    partialShot: Omit<
      Shot,
      "embedding" | "frameEmbeddings" | "thumbnailDataUrl" | "caption" | "cloudCaption"
    >,
    thumbnailDataUrl: string,
    frames: Array<{ data: ArrayBuffer; width: number; height: number }>,
  ) {
    const shot: Shot = {
      ...partialShot,
      thumbnailDataUrl,
      embedding: null,
      frameEmbeddings: [],
      caption: null,
      cloudCaption: null,
    };
    run.shots.push(shot);
    this.emit({ kind: "shot", clipId: run.clipId, shot });

    // Embed every sampled frame (frames[0] = rep). The shot announces itself
    // embedded once all of its frames resolve.
    let remaining = frames.length;
    const results: (Float32Array | null)[] = new Array(frames.length).fill(null);

    const settle = () => {
      remaining -= 1;
      if (remaining === 0) {
        shot.frameEmbeddings = results.filter((v): v is Float32Array => v !== null);
        shot.embedding = results[0] ?? shot.frameEmbeddings[0] ?? null;
        this.emit({ kind: "shot-embedded", clipId: run.clipId, shotIndex: shot.index });
      }
      const next = run.embedQueue.shift();
      if (next) next();
      this.maybeFinish(run);
    };

    frames.forEach((pixels, frameIdx) => {
      const submit = () => {
        run.embedsInFlight += 1;
        const requestId = uid("img");
        this.pendingEmbeds.set(requestId, {
          resolve: (vector, ms) => {
            results[frameIdx] = vector;
            run.embedMsTotal += ms;
            run.embedCount += 1;
            run.embedsInFlight -= 1;
            settle();
          },
          reject: () => {
            // Embedding failure is non-fatal; this frame stays null.
            run.embedsInFlight -= 1;
            settle();
          },
        });
        this.embeddingWorker!.postMessage(
          { type: "embed-image", requestId, pixels },
          [pixels.data],
        );
      };
      if (run.embedsInFlight < MAX_EMBED_IN_FLIGHT) {
        submit();
      } else {
        run.embedQueue.push(submit);
      }
    });
  }

  private maybeFinish(run: ClipRun) {
    if (run.finished) return;
    if (!run.visualDone || !run.audioDone) return;
    if (run.embedsInFlight > 0 || run.embedQueue.length > 0) return;

    run.finished = true;
    this.runsByClipId.delete(run.clipId);
    // Free the multi-GB OPFS scratch copy — the dossier is all we keep.
    this.funnelWorker?.postMessage({ type: "cleanup", clipId: run.clipId });

    const totalMs = performance.now() - run.startMs;
    const durationS = run.meta?.durationS ?? 0;
    const perf: DossierPerf = {
      ingestMs: run.ingestMs,
      usedOpfs: run.usedOpfs,
      decodeMs: run.decodeMs,
      framesDecoded: run.framesDecoded,
      analysisFps: run.decodeMs > 0 ? (run.framesDecoded / run.decodeMs) * 1000 : 0,
      realtimeFactor: run.decodeMs > 0 ? durationS / (run.decodeMs / 1000) : 0,
      embedMs: run.embedMsTotal,
      embedPerFrameMs: run.embedCount > 0 ? run.embedMsTotal / run.embedCount : 0,
      audioDecodeMs: run.audioDecodeMs,
      whisperMs: run.whisperMs,
      whisperRealtimeFactor:
        run.whisperMs > 0 ? run.audioDurationS / (run.whisperMs / 1000) : 0,
      modelLoadMs: { clip: this.clipModelLoadMs, whisper: this.whisperModelLoadMs },
      totalMs,
      device: { embed: this.embedDevice, whisper: this.whisperDevice },
      cacheHit: false,
      ingestWindows: run.ingestWindows,
    };

    const dossier: ClipDossier = {
      version: DOSSIER_VERSION,
      clipId: run.clipId,
      cacheKey: "", // filled by DossierCache on save (derived from file)
      fileName: run.identityFile.name,
      analyzedFromProxy:
        run.identityFile !== run.file ? run.file.name : undefined,
      recordedAt: run.identityFile.lastModified ?? null,
      durationS,
      analyzedThroughS: run.analyzedThroughS,
      width: run.meta?.width ?? 0,
      height: run.meta?.height ?? 0,
      shots: run.shots,
      denseFrames: run.denseFrames,
      denseCaptions: [],
      cloudDenseCaptions: [],
      cloudShotCaptions: [],
      cloudRuns: { shots: null, timeline: null },
      cloudRunArchive: [],
      cloudVision: null,
      localCaptionPerf: null,
      transcript: run.transcript,
      audioEnvelope: run.audioEnvelope,
      audioEvents: run.audioEvents,
      perf,
    };

    void this.cache.save(run.identityFile, dossier);
    this.emit({ kind: "clip-done", clipId: run.clipId, dossier });
    run.resolve(dossier);
    // Scene descriptions are background enrichment: the dossier is already
    // cached and usable; captions land frame by frame and re-save as they go.
    if (dossier.denseFrames.length > 0) {
      this.captionDense(run.identityFile, dossier);
    } else {
      this.enrichCaptions(run.identityFile, dossier);
    }
  }

  /**
   * Caption the dossier's dense frames, filling the denseCaptions timeline
   * and each shot's caption (nearest frame to its rep time). Frames already
   * captioned (resume after an interrupted pass) are skipped by timestamp;
   * blurry frames skip FastVLM and get the canned BLURRY_FRAME_CAPTION
   * annotation (same gate as the cloud pass) so downstream consumers still
   * see one annotation per frame. Serialized globally; incremental cache
   * saves are throttled fire-and-forget (they re-serialize the WHOLE
   * dossier) with a guaranteed final awaited save.
   */
  private captionDense(
    file: File,
    dossier: ClipDossier,
    device: "auto" | InferenceDevice = "auto",
  ) {
    const pending = planLocalCaptionFrames(dossier.denseFrames, dossier.denseCaptions);
    if (pending.length === 0) {
      this.syncShotCaptions(dossier);
      return;
    }
    this.ensureCaptionWorker(device);
    const total = dossier.denseFrames.length;
    const saver = new ThrottledDossierSaver(
      () => this.cache.save(file, dossier),
      CAPTION_SAVE_MIN_INTERVAL_MS,
    );

    this.captionChain = this.captionChain.then(async () => {
      const captions: DenseCaption[] = dossier.denseCaptions;
      let done = total - pending.length;
      for (const { frame, blurry } of pending) {
        if (blurry) {
          // No model call — the frame is below the cloud pass's blur
          // threshold, so FastVLM would only describe motion smear.
          captions.push({ t: frame.t, text: BLURRY_FRAME_CAPTION });
        } else {
          try {
            const { caption: raw, ms } = await this.requestCaption(frame.dataUrl);
            const text = cleanCaption(raw);
            if (text) captions.push({ t: frame.t, text });
            const perf = dossier.localCaptionPerf ?? { totalMs: 0, frames: 0 };
            perf.totalMs += ms;
            perf.frames += 1;
            dossier.localCaptionPerf = perf;
          } catch {
            // best-effort; skip this frame
          }
        }
        done += 1;
        this.emit({ kind: "dense-captions", clipId: dossier.clipId, done, total });
        if (done % CAPTION_SAVE_EVERY_FRAMES === 0) {
          this.syncShotCaptions(dossier);
          saver.request();
        }
      }
      this.syncShotCaptions(dossier);
      await saver.flush();
    });
  }

  /** Persist a dossier mutated outside the orchestrator (e.g. cloud enhance). */
  saveDossier(file: File, dossier: ClipDossier): Promise<void> {
    return this.cache.save(file, dossier);
  }

  /** Give each still-uncaptioned shot the dense caption nearest its rep frame. */
  private syncShotCaptions(dossier: ClipDossier) {
    for (const shot of dossier.shots) {
      if (shot.caption) continue;
      let best: DenseCaption | null = null;
      for (const c of dossier.denseCaptions) {
        if (c.t < shot.tStart - 1 || c.t > shot.tEnd + 1) continue;
        if (!best || Math.abs(c.t - shot.repFrameTime) < Math.abs(best.t - shot.repFrameTime)) {
          best = c;
        }
      }
      if (best) {
        shot.caption = best.text;
        this.emit({
          kind: "shot-captioned",
          clipId: dossier.clipId,
          shotIndex: shot.index,
          caption: best.text,
        });
      }
    }
  }

  /**
   * Fill in missing shot captions from the stored thumbnails (works for both
   * fresh dossiers and pre-caption cache hits — no video decode involved).
   * Serialized globally; failures are non-fatal per shot.
   */
  private enrichCaptions(
    file: File,
    dossier: ClipDossier,
    device: "auto" | InferenceDevice = "auto",
  ) {
    const missing = dossier.shots.filter((s) => !s.caption && s.thumbnailDataUrl);
    if (missing.length === 0) return;
    this.ensureCaptionWorker(device);

    this.captionChain = this.captionChain.then(async () => {
      let updated = false;
      for (const shot of missing) {
        try {
          const { caption } = await this.requestCaption(shot.thumbnailDataUrl);
          if (!caption) continue;
          shot.caption = caption;
          updated = true;
          this.emit({
            kind: "shot-captioned",
            clipId: dossier.clipId,
            shotIndex: shot.index,
            caption,
          });
        } catch {
          // Captioning is best-effort; the shot keeps caption: null.
        }
      }
      if (updated) await this.cache.save(file, dossier).catch(() => undefined);
    });
  }

  /**
   * Backfill audioEnvelope/audioEvents for a cache-hit dossier that predates
   * these fields (or never got a response), without re-running ASR. Fires a
   * single envelopeOnly transcribe request; the whisper worker serializes
   * ALL "transcribe" messages itself (a promise chain in its onmessage
   * handler), so this never interleaves mid-decode with a live
   * transcription or another enrichment pass — no extra queue needed here.
   */
  private enrichAudioSignals(
    file: File,
    dossier: ClipDossier,
    device: "auto" | InferenceDevice = "auto",
    /**
     * File the enriched dossier is SAVED under. Differs from `file` for
     * proxy pairs: decode the small proxy, key the cache on the original.
     */
    saveFile: File = file,
  ) {
    // undefined = never computed; null = computed, no audio track (skip).
    if (dossier.audioEnvelope !== undefined) return;
    if (this.pendingAudioEnrichment.has(dossier.clipId)) return;
    this.ensureWhisperWorker(device);
    this.pendingAudioEnrichment.set(dossier.clipId, { file: saveFile, dossier });
    this.whisperWorker!.postMessage({
      type: "transcribe",
      requestId: uid("whisper-env"),
      clipId: dossier.clipId,
      blob: file,
      opfsKey: null,
      partial: null,
      capS: dossier.analyzedThroughS,
      envelopeOnly: true,
    });
  }

  /** Resolves with the caption and the worker-measured COMPUTE time (model
   * load/download excluded — that would poison speed comparisons). */
  private requestCaption(image: string): Promise<{ caption: string; ms: number }> {
    const requestId = uid("cap");
    return new Promise<{ caption: string; ms: number }>((resolve, reject) => {
      this.pendingCaptions.set(requestId, {
        resolve: (caption, ms) => resolve({ caption, ms }),
        reject,
      });
      this.captionWorker!.postMessage({ type: "caption", requestId, image });
    });
  }

  private failRun(run: ClipRun, message: string) {
    if (run.finished) return;
    run.finished = true;
    this.runsByClipId.delete(run.clipId);
    this.funnelWorker?.postMessage({ type: "cleanup", clipId: run.clipId });
    console.error(`[perception] clip "${run.file.name}" failed:`, message);
    this.emit({ kind: "clip-error", clipId: run.clipId, message });
    run.reject(new Error(message));
  }

  // -------------------------------------------------------------------------

  private ensureFunnelWorker(): Worker {
    if (!this.funnelWorker) {
      this.funnelWorker = createFunnelWorker();
      this.funnelWorker.postMessage({ type: "init" }); // clear stale OPFS scratch
      this.funnelWorker.addEventListener("error", (event) => {
        // Uncaught worker exception (e.g. OOM crash) — fail all active runs
        // so the UI doesn't hang forever.
        console.error("[perception] funnel worker crashed:", event.message, event);
        for (const run of [...this.runsByClipId.values()]) {
          this.failRun(run, `funnel worker crashed: ${event.message || "unknown error"}`);
        }
      });
    }
    return this.funnelWorker;
  }

  private ensureEmbeddingWorker(device: "auto" | InferenceDevice): Worker {
    if (!this.embeddingWorker) {
      this.embeddingWorker = createEmbeddingWorker();
      this.embeddingWorker.addEventListener(
        "message",
        (event: MessageEvent<EmbedResponse>) => this.handleEmbedResponse(event.data),
      );
      this.embeddingWorker.postMessage({ type: "init", device });
    }
    return this.embeddingWorker;
  }

  private ensureWhisperWorker(device: "auto" | InferenceDevice): Worker {
    if (!this.whisperWorker) {
      this.whisperWorker = createWhisperWorker();
      this.whisperWorker.addEventListener(
        "message",
        (event: MessageEvent<WhisperResponse>) => this.handleWhisperResponse(event.data),
      );
      this.whisperWorker.postMessage({ type: "init", device });
    }
    return this.whisperWorker;
  }

  /** Created lazily on first caption need — FastVLM (~1GB) shouldn't gate page load. */
  private ensureCaptionWorker(device: "auto" | InferenceDevice): Worker {
    if (!this.captionWorker) {
      this.captionWorker = createCaptionWorker();
      this.captionWorker.addEventListener(
        "message",
        (event: MessageEvent<CaptionWorkerResponse>) => this.handleCaptionResponse(event.data),
      );
      this.captionWorker.addEventListener("error", (event) => {
        console.error("[perception] caption worker crashed:", event.message, event);
        for (const [, pending] of this.pendingCaptions) {
          pending.reject(new Error(event.message || "caption worker crashed"));
        }
        this.pendingCaptions.clear();
      });
      this.captionWorker.postMessage({ type: "init", device });
    }
    return this.captionWorker;
  }

  private handleCaptionResponse(msg: CaptionWorkerResponse) {
    switch (msg.type) {
      case "ready":
        this.emit({
          kind: "model-ready",
          model: "captioner",
          device: msg.device,
          loadMs: msg.loadMs,
        });
        break;
      case "model-progress":
        this.emit({
          kind: "model-progress",
          model: "captioner",
          file: msg.file,
          loaded: msg.loaded,
          total: msg.total,
        });
        break;
      case "caption": {
        const pending = this.pendingCaptions.get(msg.requestId);
        if (pending) {
          this.pendingCaptions.delete(msg.requestId);
          pending.resolve(msg.caption, msg.ms);
        }
        break;
      }
      case "error": {
        const pending = msg.requestId ? this.pendingCaptions.get(msg.requestId) : undefined;
        if (pending && msg.requestId) {
          this.pendingCaptions.delete(msg.requestId);
          pending.reject(new Error(msg.message));
        }
        break;
      }
    }
  }

  private handleEmbedResponse(msg: EmbedResponse) {
    switch (msg.type) {
      case "ready":
        this.embedDevice = msg.device;
        this.clipModelLoadMs = msg.loadMs;
        this.emit({ kind: "model-ready", model: "embed", device: msg.device, loadMs: msg.loadMs });
        break;
      case "model-progress":
        this.emit({
          kind: "model-progress",
          model: "embed",
          file: msg.file,
          loaded: msg.loaded,
          total: msg.total,
        });
        break;
      case "embedding": {
        const pending = msg.requestId ? this.pendingEmbeds.get(msg.requestId) : undefined;
        if (pending && msg.requestId) {
          this.pendingEmbeds.delete(msg.requestId);
          pending.resolve(new Float32Array(msg.vector), msg.ms);
        }
        break;
      }
      case "error": {
        const pending = msg.requestId ? this.pendingEmbeds.get(msg.requestId) : undefined;
        if (pending && msg.requestId) {
          this.pendingEmbeds.delete(msg.requestId);
          pending.reject(new Error(msg.message));
        }
        break;
      }
    }
  }

  private handleWhisperResponse(msg: WhisperResponse) {
    switch (msg.type) {
      case "ready":
        this.whisperDevice = msg.device;
        this.whisperModelLoadMs = msg.loadMs;
        this.emit({
          kind: "model-ready",
          model: "whisper",
          device: msg.device,
          loadMs: msg.loadMs,
        });
        break;
      case "model-progress":
        this.emit({
          kind: "model-progress",
          model: "whisper",
          file: msg.file,
          loaded: msg.loaded,
          total: msg.total,
        });
        break;
      case "segments": {
        if (msg.envelopeOnly) {
          // Retroactive enrichment response for a cache-hit dossier — NOT a
          // live pipeline run. Only set audio fields; never touch
          // transcript/whisper perf (segments is always [] here).
          const pending = this.pendingAudioEnrichment.get(msg.clipId);
          if (pending) {
            this.pendingAudioEnrichment.delete(msg.clipId);
            const { file, dossier } = pending;
            dossier.audioEnvelope = msg.audioEnvelope ?? null;
            dossier.audioEvents = msg.audioEvents ?? [];
            if (dossier.audioEnvelope) {
              this.emit({
                kind: "audio-signals",
                clipId: dossier.clipId,
                envelope: dossier.audioEnvelope,
                events: dossier.audioEvents,
              });
            }
            void this.cache.save(file, dossier).catch(() => undefined);
          }
          break;
        }

        const run = msg.clipId ? this.runsByClipId.get(msg.clipId) : undefined;
        if (run) {
          run.transcript = msg.segments;
          run.audioDecodeMs = msg.perf.audioDecodeMs;
          run.whisperMs = msg.perf.whisperMs;
          run.audioDurationS = msg.perf.audioDurationS;
          run.audioEnvelope = msg.audioEnvelope ?? null;
          run.audioEvents = msg.audioEvents ?? [];
          run.audioDone = true;
          this.emit({ kind: "transcript", clipId: run.clipId, segments: msg.segments });
          if (run.audioEnvelope) {
            this.emit({
              kind: "audio-signals",
              clipId: run.clipId,
              envelope: run.audioEnvelope,
              events: run.audioEvents,
            });
          }
          this.maybeFinish(run);
        }
        break;
      }
      case "error": {
        const run = msg.clipId ? this.runsByClipId.get(msg.clipId) : undefined;
        if (run) {
          // Whisper failure is non-fatal: keep the visual dossier.
          run.transcript = [];
          run.audioDone = true;
          this.maybeFinish(run);
        }
        if (msg.clipId) this.pendingAudioEnrichment.delete(msg.clipId);
        break;
      }
    }
  }
}
