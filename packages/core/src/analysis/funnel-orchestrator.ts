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
import { DossierCache } from "./dossier-cache";
import {
  DOSSIER_VERSION,
  FUNNEL_DEFAULTS,
  type ClipDossier,
  type DenseCaption,
  type DossierPerf,
  type FunnelProgressEvent,
  type InferenceDevice,
  type Shot,
  type TranscriptSegment,
} from "./types";
import type {
  CaptionWorkerResponse,
  EmbedResponse,
  FunnelResponse,
  WhisperResponse,
} from "./worker-protocol";

export type ProgressListener = (event: FunnelProgressEvent) => void;

/** Max embedding requests in flight (backpressure). */
const MAX_EMBED_IN_FLIGHT = 4;

interface PendingEmbed {
  resolve: (vector: Float32Array, ms: number) => void;
  reject: (err: Error) => void;
}

interface PendingCaption {
  resolve: (caption: string) => void;
  reject: (err: Error) => void;
}

interface ClipRun {
  clipId: string;
  file: File;
  shots: Shot[];
  denseFrames: Array<{ t: number; dataUrl: string }>;
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
  ingestMs: number;
  usedOpfs: boolean;
  analyzedThroughS: number | null;
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
  ): Promise<ClipDossier> {
    const cached = await this.cache.load(file);
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
      this.emit({ kind: "clip-done", clipId, dossier });
      // Dense frames persist in the dossier, so an interrupted caption pass
      // resumes from where it stopped — no re-decode.
      if (dossier.denseFrames.length > 0) {
        this.captionDense(file, dossier, device);
      } else {
        this.enrichCaptions(file, dossier, device);
      }
      return dossier;
    }

    const run: ClipRun = {
      clipId,
      file,
      shots: [],
      denseFrames: [],
      transcript: [],
      meta: null,
      startMs: performance.now(),
      decodeMs: 0,
      ingestMs: 0,
      usedOpfs: false,
      analyzedThroughS: null,
      framesDecoded: 0,
      embedMsTotal: 0,
      embedCount: 0,
      audioDecodeMs: 0,
      whisperMs: 0,
      audioDurationS: 0,
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
            this.handleShot(run, msg.shot, msg.thumbJpeg, msg.frames);
            break;

          case "dense-frame":
            run.denseFrames.push({ t: msg.t, dataUrl: jpegToDataUrl(msg.jpeg) });
            break;

          case "ingest-progress":
            this.emit({
              kind: "ingest-progress",
              clipId: run.clipId,
              bytesDone: msg.bytesDone,
              bytesTotal: msg.bytesTotal,
            });
            break;

          case "done":
            run.decodeMs = msg.perf.decodeMs;
            run.ingestMs = msg.perf.ingestMs;
            run.usedOpfs = msg.usedOpfs;
            run.framesDecoded = msg.perf.framesDecoded;
            run.visualDone = true;
            worker.removeEventListener("message", handler);
            resolveVisual();
            // Start the audio pass now that the funnel worker is done reading
            // this file (whisper worker serializes its own queue).
            this.whisperWorker?.postMessage({
              type: "transcribe",
              requestId: uid("whisper"),
              clipId: run.clipId,
              blob: run.file,
              opfsKey: msg.usedOpfs ? run.clipId : null,
              partial: msg.partial,
              capS: msg.analyzedThroughS,
            });
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
      });
    });
  }

  private handleShot(
    run: ClipRun,
    partialShot: Omit<
      Shot,
      "embedding" | "frameEmbeddings" | "thumbnailDataUrl" | "caption" | "cloudCaption"
    >,
    thumbJpeg: ArrayBuffer,
    frames: Array<{ data: ArrayBuffer; width: number; height: number }>,
  ) {
    const thumbnailDataUrl = jpegToDataUrl(thumbJpeg);
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
    };

    const dossier: ClipDossier = {
      version: DOSSIER_VERSION,
      clipId: run.clipId,
      cacheKey: "", // filled by DossierCache on save (derived from file)
      fileName: run.file.name,
      recordedAt: run.file.lastModified ?? null,
      durationS,
      analyzedThroughS: run.analyzedThroughS,
      width: run.meta?.width ?? 0,
      height: run.meta?.height ?? 0,
      shots: run.shots,
      denseFrames: run.denseFrames,
      denseCaptions: [],
      cloudDenseCaptions: [],
      cloudVision: null,
      transcript: run.transcript,
      perf,
    };

    void this.cache.save(run.file, dossier);
    this.emit({ kind: "clip-done", clipId: run.clipId, dossier });
    run.resolve(dossier);
    // Scene descriptions are background enrichment: the dossier is already
    // cached and usable; captions land frame by frame and re-save as they go.
    if (dossier.denseFrames.length > 0) {
      this.captionDense(run.file, dossier);
    } else {
      this.enrichCaptions(run.file, dossier);
    }
  }

  /**
   * Caption the dossier's dense frames, filling the denseCaptions timeline
   * and each shot's caption (nearest frame to its rep time). Frames already
   * captioned (resume after an interrupted pass) are skipped by timestamp.
   * Serialized globally, incremental cache saves for crash resilience.
   */
  private captionDense(
    file: File,
    dossier: ClipDossier,
    device: "auto" | InferenceDevice = "auto",
  ) {
    // Resume point: captions are appended in frame order, so anything at or
    // before the last captioned timestamp is done (failed frames retry).
    const lastT =
      dossier.denseCaptions.length > 0
        ? dossier.denseCaptions[dossier.denseCaptions.length - 1].t
        : -Infinity;
    const frames = dossier.denseFrames.filter((f) => f.t > lastT);
    if (frames.length === 0) {
      this.syncShotCaptions(dossier);
      return;
    }
    this.ensureCaptionWorker(device);
    const total = dossier.denseFrames.length;

    this.captionChain = this.captionChain.then(async () => {
      const captions: DenseCaption[] = dossier.denseCaptions;
      let done = total - frames.length;
      for (const frame of frames) {
        try {
          const raw = await this.requestCaption(frame.dataUrl);
          const text = cleanCaption(raw);
          if (text) captions.push({ t: frame.t, text });
        } catch {
          // best-effort; skip this frame
        }
        done += 1;
        this.emit({ kind: "dense-captions", clipId: dossier.clipId, done, total });
        if (done % 25 === 0) {
          this.syncShotCaptions(dossier);
          await this.cache.save(file, dossier).catch(() => undefined);
        }
      }
      this.syncShotCaptions(dossier);
      await this.cache.save(file, dossier).catch(() => undefined);
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
          const caption = await this.requestCaption(shot.thumbnailDataUrl);
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

  private requestCaption(image: string): Promise<string> {
    const requestId = uid("cap");
    return new Promise<string>((resolve, reject) => {
      this.pendingCaptions.set(requestId, { resolve, reject });
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
          pending.resolve(msg.caption);
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
        const run = msg.clipId ? this.runsByClipId.get(msg.clipId) : undefined;
        if (run) {
          run.transcript = msg.segments;
          run.audioDecodeMs = msg.perf.audioDecodeMs;
          run.whisperMs = msg.perf.whisperMs;
          run.audioDurationS = msg.perf.audioDurationS;
          run.audioDone = true;
          this.emit({ kind: "transcript", clipId: run.clipId, segments: msg.segments });
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
        break;
      }
    }
  }
}

function jpegToDataUrl(jpeg: ArrayBuffer): string {
  const bytes = new Uint8Array(jpeg);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
