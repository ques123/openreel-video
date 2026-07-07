/**
 * Real-time render of the screening room's cut into one downloadable video —
 * REUSES services/debug-export.ts's proven pattern (canvas.captureStream +
 * MediaRecorder, vp9/opus with vp8 fallback; a Worker-driven frame ticker,
 * since a backgrounded tab clamps rAF/setInterval to ~1Hz and would freeze a
 * real-time render mid-cut — a Worker's own timer is exempt) with every
 * debug overlay/title card removed: clean frames + audio only, including the
 * music bed when the cut has one. Reimplemented rather than imported because
 * exportDebugVideo always burns in the diagnostic overlay/banner/title card
 * — this file has no debug-export import at all except the generic,
 * overlay-free `downloadBlob` helper.
 *
 * Output is a WebM container (vp9/opus) — same as debug-export, which does
 * not mux to MP4 either. The wireframe's example filename
 * ("golden-hour-mostly.mp4") is adjusted to .webm in RenderOverlay.tsx: that
 * literal extension was demo flavor-text, and shipping a file whose
 * extension doesn't match its actual container would be a real bug, not a
 * cosmetic one.
 */
import { MUSIC_BED_VOLUME } from "@openreel/core";
import type { PublicCut } from "../publicflow/types";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

export class RenderCancelledError extends Error {
  constructor() {
    super("render cancelled");
    this.name = "RenderCancelledError";
  }
}

export interface RenderProgress {
  fraction: number; // 0..1 over the whole cut
  elapsedS: number;
  totalS: number;
}

export interface RenderCutParams {
  cut: PublicCut;
  getFile: (clipId: string) => File | null;
  /** Already-resolved to whichever take (A/B) is selected; null = no music. */
  musicUrl: string | null;
  onProgress: (p: RenderProgress) => void;
  signal: AbortSignal;
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(video.error?.message ?? "video error"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = t;
  });
}

function waitMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener(
      "error",
      () => reject(new Error(video.error?.message ?? "load error")),
      { once: true },
    );
  });
}

export async function renderCut(params: RenderCutParams): Promise<Blob> {
  const { cut, getFile, musicUrl, onProgress, signal } = params;
  if (signal.aborted) throw new RenderCancelledError();

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  const stream = canvas.captureStream(FPS);
  const audioCtx = new AudioContext();
  const audioDest = audioCtx.createMediaStreamDestination();
  stream.addTrack(audioDest.stream.getAudioTracks()[0]);

  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const recorderDone = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  let musicBedSource: AudioBufferSourceNode | null = null;
  if (musicUrl) {
    try {
      const res = await fetch(musicUrl);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(buf);
        const gain = audioCtx.createGain();
        gain.gain.value = MUSIC_BED_VOLUME;
        musicBedSource = audioCtx.createBufferSource();
        musicBedSource.buffer = audioBuffer;
        musicBedSource.loop = true;
        musicBedSource.connect(gain).connect(audioDest);
      }
    } catch (err) {
      console.error("[wizz] music bed failed to load for render — rendering without it", err);
    }
  }

  recorder.start(250);
  musicBedSource?.start();

  const TICK_MS = Math.round(1000 / FPS);
  const tickerWorker = new Worker(
    URL.createObjectURL(
      new Blob([`setInterval(() => postMessage(0), ${TICK_MS});`], { type: "text/javascript" }),
    ),
  );
  let lastPaintMs = 0;
  const markPaint = () => {
    lastPaintMs = performance.now();
  };
  let onTick: (() => void) | null = null;
  tickerWorker.onmessage = () => {
    onTick?.();
    // Heartbeat: captureStream only emits on canvas activity, so any awaited
    // gap (seek/metadata between segments) would starve the video track;
    // re-emitting the current pixels turns that into a clean, intentional
    // hold instead of a stalled decoder for players.
    if (musicBedSource && performance.now() - lastPaintMs > TICK_MS * 1.5) {
      ctx.drawImage(canvas, 0, 0);
      markPaint();
    }
  };
  const tickUntil = (fn: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      onTick = () => {
        if (signal.aborted) {
          onTick = null;
          reject(new RenderCancelledError());
          return;
        }
        try {
          if (fn()) {
            onTick = null;
            resolve();
          }
        } catch (err) {
          onTick = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
    });

  const totalS = cut.totalS || 1;
  let elapsedBeforeSegmentS = 0;

  const holdBlack = (seconds: number, startOffsetS: number) => {
    const startPerf = performance.now();
    const untilPerf = startPerf + seconds * 1000;
    return tickUntil(() => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      markPaint();
      const withinS = Math.min(seconds, (performance.now() - startPerf) / 1000);
      onProgress({
        fraction: Math.min(1, (startOffsetS + withinS) / totalS),
        elapsedS: startOffsetS + withinS,
        totalS,
      });
      return performance.now() >= untilPerf;
    });
  };

  try {
    for (const seg of cut.segments) {
      const startOffsetS = elapsedBeforeSegmentS;
      const segDurationS = Math.max(0, seg.outS - seg.inS);
      const file = getFile(seg.clipId);

      if (!file) {
        await holdBlack(segDurationS || 1, startOffsetS);
        elapsedBeforeSegmentS += segDurationS || 1;
        continue;
      }

      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.src = url;
      video.playsInline = true;
      video.preload = "auto";
      let source: MediaElementAudioSourceNode | null = null;
      try {
        await waitMetadata(video);
        await seekTo(video, seg.inS);
        source = audioCtx.createMediaElementSource(video);
        source.connect(audioDest); // graph-only — never reaches speakers
        await video.play();

        await tickUntil(() => {
          if (video.error) throw new Error(video.error.message ?? "playback error");
          ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
          markPaint();
          const withinS = Math.max(0, video.currentTime - seg.inS);
          onProgress({
            fraction: Math.min(1, (startOffsetS + withinS) / totalS),
            elapsedS: startOffsetS + withinS,
            totalS,
          });
          if (video.currentTime >= seg.outS || video.ended) {
            video.pause();
            return true;
          }
          return false;
        });
      } finally {
        source?.disconnect();
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      }
      elapsedBeforeSegmentS += segDurationS;
    }
  } finally {
    onTick = null;
    tickerWorker.terminate();
    try {
      musicBedSource?.stop();
    } catch {
      // already stopped or never started — nothing to clean up
    }
    recorder.stop();
    await recorderDone;
    await audioCtx.close().catch(() => undefined);
    stream.getTracks().forEach((t) => t.stop());
  }

  onProgress({ fraction: 1, elapsedS: totalS, totalS });
  return new Blob(chunks, { type: "video/webm" });
}

/** "Golden Hour, Mostly" → "golden-hour-mostly" for the downloaded filename. */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "wizz-cut";
}
