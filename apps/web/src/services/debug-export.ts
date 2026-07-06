/**
 * Debug video export: renders a storyboard into ONE downloadable WebM by
 * playing each segment from its original file into a canvas and burning in a
 * diagnostic overlay (sequence position, filename, role, shot, timecodes, the
 * director's "why", and which search queries surfaced the shot). A leading
 * title card records the experiment settings so exported cuts stay
 * self-describing when compared later.
 *
 * Canvas.captureStream + MediaRecorder (vp9/opus, vp8 fallback) — rendering
 * runs in real time (a 30s cut takes ~30s), with per-segment progress.
 */

import {
  MUSIC_BED_VOLUME,
  type DirectorActivity,
  type PromptSources,
  type Storyboard,
  type StoryboardItem,
} from "@openreel/core";
import { estimateCostUSD, fmtUSD } from "./model-pricing";
import {
  experimentCaptionCostUSD,
  fmtDurationMs,
  fmtTokens,
  type ExperimentCaptionStats,
} from "./experiments";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const TITLE_CARD_S = 2.5;

export interface DebugExportMeta {
  brief: string;
  targetDurationS: number | null;
  promptSources: PromptSources;
  model: string;
  at: number;
  usage?: { promptTokens: number; completionTokens: number; calls: number };
  /** Total LLM wall-clock for the director run; absent on legacy experiments. */
  durationMs?: number;
  /** Number of source clips referenced by the experiment (distinct from segment count). */
  clipCount?: number;
  /** Cloud caption model(s) behind the run's timelines ("" = local only); absent = never tracked. */
  captionModels?: string;
  /** Captioning cost/time aggregates; absent on legacy experiments. */
  captionStats?: ExperimentCaptionStats;
  /** Non-fatal issues surfaced during the run; absent/empty renders nothing. */
  warnings?: string[];
  /**
   * The committed background-music track, if any — absent entirely when
   * nothing was committed (no music toggle, or generated-but-unpicked).
   * audioUrl is already proxied (proxiedMusicUrl); null = info-only title
   * card line with no actual bed mixed into the render.
   */
  music?: {
    title: string;
    modelName: string;
    durationS: number;
    /** 1-based index of the committed track among the A/B'd takes. */
    trackIndex: number;
    trackCount: number;
    audioUrl: string | null;
  };
}

export interface DebugExportContext {
  storyboard: Storyboard;
  meta: DebugExportMeta;
  activity: DirectorActivity[];
  getFile: (clipId: string) => File | null;
  fileNameOf: (clipId: string) => string;
  onProgress?: (message: string) => void;
}

/** Queries whose results included a shot — "how the director found this". */
export function searchQueriesByShot(activity: DirectorActivity[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const a of activity) {
    if (a.kind !== "search" || !a.hits) continue;
    for (const hit of a.hits) {
      if (!hit.confident) continue;
      const key = `${hit.clipId}#${hit.shotIndex}`;
      const list = map.get(key) ?? [];
      if (!list.includes(a.query)) list.push(a.query);
      map.set(key, list);
    }
  }
  return map;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) {
        // Last permitted line: consume the rest and ellipsize.
        const rest = words.slice(words.indexOf(word)).join(" ");
        let clipped = rest;
        while (clipped && ctx.measureText(clipped + "…").width > maxWidth) {
          clipped = clipped.slice(0, -1);
        }
        lines.push(clipped + (clipped.length < rest.length ? "…" : ""));
        return lines;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fmtS(s: number): string {
  return s.toFixed(1) + "s";
}

/** Compact source-mix label, shared style with the experiments panel. */
export function sourcesBadge(src: PromptSources): string {
  const parts: string[] = [];
  if (src.localCaptions) parts.push("local");
  if (src.cloudShots) parts.push("c·shots");
  if (src.cloudTimeline) parts.push("c·timeline");
  if (src.transcript) parts.push("script");
  return parts.join("+") || "no sources";
}

/**
 * Persistent top banner: the experiment this render belongs to + its caption
 * settings — so side-by-side comparisons stay identifiable frame one. Titles
 * wrap (rather than hard-truncate) over up to 2 lines; the box grows to fit.
 */
function drawExperimentBanner(
  ctx: CanvasRenderingContext2D,
  title: string,
  badge: string,
): void {
  const pad = 14;
  const lineH = 22;
  ctx.font = "15px ui-monospace, monospace";
  const badgeText = "· " + badge;
  const badgeWidth = ctx.measureText(badgeText).width;
  ctx.font = "600 17px ui-monospace, monospace";
  // Reserve room for the badge alongside the last title line so it never
  // runs off-canvas once titles are allowed to use the full width.
  const lines = wrapText(ctx, title, WIDTH - pad * 2 - badgeWidth - 10, 2);
  const h = 34 + (lines.length - 1) * lineH;
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  ctx.fillRect(0, 0, WIDTH, h);

  ctx.fillStyle = "#7dd3fc";
  ctx.font = "600 17px ui-monospace, monospace";
  let y = 23;
  for (const line of lines) {
    ctx.fillText(line, pad, y);
    y += lineH;
  }
  const lastLine = lines[lines.length - 1] ?? "";
  const tw = ctx.measureText(lastLine).width;
  ctx.fillStyle = "#a3a3a3";
  ctx.font = "15px ui-monospace, monospace";
  ctx.fillText(badgeText, pad + tw + 10, 23 + (lines.length - 1) * lineH);
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  item: StoryboardItem,
  index: number,
  total: number,
  fileName: string,
  currentT: number,
  queries: string[],
): void {
  const pad = 14;
  ctx.font = "600 20px ui-monospace, monospace";
  const whyLines = (() => {
    ctx.font = "15px system-ui, sans-serif";
    return wrapText(ctx, `why: ${item.why}`, WIDTH - pad * 2, 2);
  })();
  const foundBy =
    queries.length > 0 ? `found by: ${queries.map((q) => `"${q}"`).join("  ")}` : "found from dossier read (no search hit)";
  const barH = 30 + 24 + whyLines.length * 20 + 22 + pad;

  ctx.fillStyle = "rgba(0,0,0,0.62)";
  ctx.fillRect(0, HEIGHT - barH, WIDTH, barH);

  let y = HEIGHT - barH + 26;
  ctx.fillStyle = "#7dd3fc";
  ctx.font = "600 20px ui-monospace, monospace";
  ctx.fillText(
    `[${index + 1}/${total}] ${item.role.toUpperCase()}  ·  ${fileName}  ·  clip shot #${item.shotIndex ?? "?"}`,
    pad,
    y,
  );
  y += 24;
  ctx.fillStyle = "#e5e5e5";
  ctx.font = "16px ui-monospace, monospace";
  ctx.fillText(
    `${fmtS(item.inS)} → ${fmtS(item.outS)}  (t=${fmtS(currentT)}, seg ${fmtS(item.outS - item.inS)})`,
    pad,
    y,
  );
  y += 22;
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillStyle = "#d4d4d4";
  for (const line of whyLines) {
    ctx.fillText(line, pad, y);
    y += 20;
  }
  ctx.fillStyle = "#a3e635";
  ctx.font = "14px ui-monospace, monospace";
  const foundLines = wrapText(ctx, foundBy, WIDTH - pad * 2, 1);
  ctx.fillText(foundLines[0] ?? "", pad, y);
}

/** "director: gpt-5.2 · 14 calls · 9.1k in / 2.3k out ≈$1.23 · gen 2m15s" */
function directorLine(meta: DebugExportMeta): string | null {
  if (!meta.usage) return null;
  const { promptTokens, completionTokens, calls } = meta.usage;
  const cost = estimateCostUSD(meta.model, promptTokens, completionTokens);
  const parts = [
    meta.model,
    `${calls} calls`,
    `${fmtTokens(promptTokens)} in / ${fmtTokens(completionTokens)} out${cost !== null ? ` ≈${fmtUSD(cost)}` : ""}`,
  ];
  if (meta.durationMs) parts.push(`gen ${fmtDurationMs(meta.durationMs)}`);
  return `director: ${parts.join(" · ")}`;
}

/**
 * "captions: gpt-5.2 · 340 frames · 9.1k in / 2.3k out ≈$1.23 · cap 1m02s"
 * or, when nothing was sent to the cloud, "captions: local-only · 340
 * frames · cap 4s". Omits pieces the run has no data for; returns null when
 * there's nothing to say at all (legacy experiments predating captionStats).
 */
function captionsLine(meta: DebugExportMeta): string | null {
  const stats = meta.captionStats;
  const models = meta.captionModels;
  if (!stats && !models) return null;
  const cloudFrames = stats?.cloudFrames ?? 0;
  const localFrames = stats?.localFrames ?? 0;
  const capMs = (stats?.cloudMs ?? 0) + (stats?.localMs ?? 0);
  const cloudOnly = !models || models === "local-only";

  if (cloudFrames === 0 && cloudOnly) {
    const parts: string[] = ["local-only"];
    if (localFrames > 0) parts.push(`${localFrames} frames`);
    if (capMs > 0) parts.push(`cap ${fmtDurationMs(capMs)}`);
    return parts.length > 1 || capMs > 0 ? `captions: ${parts.join(" · ")}` : null;
  }

  const parts: string[] = [];
  if (models) parts.push(models);
  if (cloudFrames > 0) parts.push(`${cloudFrames} frames`);
  const inTok = stats?.cloudPromptTokens ?? 0;
  const outTok = stats?.cloudCompletionTokens ?? 0;
  if (inTok > 0 || outTok > 0) {
    const cost = experimentCaptionCostUSD({ captionModels: models, captionStats: stats });
    parts.push(`${fmtTokens(inTok)} in / ${fmtTokens(outTok)} out${cost !== null ? ` ≈${fmtUSD(cost)}` : ""}`);
  }
  if (capMs > 0) parts.push(`cap ${fmtDurationMs(capMs)}`);
  return parts.length > 0 ? `captions: ${parts.join(" · ")}` : null;
}

/**
 * One line per model when captionStats.byModel names 2+ differently-priced
 * models (a single model is already fully covered by captionsLine above).
 */
function captionBreakdownLines(meta: DebugExportMeta): string[] {
  const byModel = meta.captionStats?.byModel;
  if (!byModel || Object.keys(byModel).length < 2) return [];
  return Object.entries(byModel).map(([model, tok]) => {
    const cost = estimateCostUSD(model, tok.promptTokens, tok.completionTokens);
    return `  ${model}: ${fmtTokens(tok.promptTokens)} in / ${fmtTokens(tok.completionTokens)} out${cost !== null ? ` ≈${fmtUSD(cost)}` : ""}`;
  });
}

/**
 * "music: Golden Hour (score) · chirp-v5 · 42.0s · take 2/2" — wrapped (not
 * truncated) since track titles are free text and can run long. Absent when
 * nothing was committed.
 */
function musicLines(ctx: CanvasRenderingContext2D, meta: DebugExportMeta, maxWidth: number): string[] {
  const m = meta.music;
  if (!m) return [];
  const line = `music: ${m.title} · ${m.modelName} · ${m.durationS.toFixed(1)}s · take ${m.trackIndex}/${m.trackCount}`;
  return wrapText(ctx, line, maxWidth, 2);
}

function drawTitleCard(ctx: CanvasRenderingContext2D, meta: DebugExportMeta, sb: Storyboard): void {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const pad = 60;
  let y = 90;
  ctx.fillStyle = "#fafafa";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.fillText(sb.title ?? "Storyboard debug export", pad, y);
  y += 46;
  ctx.font = "17px ui-monospace, monospace";
  ctx.fillStyle = "#a3a3a3";
  const src = meta.promptSources;
  const segmentsAndClips =
    `model ${meta.model}  ·  target ${meta.targetDurationS ? fmtS(meta.targetDurationS) : "none"}  ·  ${sb.items.length} segments` +
    (meta.clipCount ? `  ·  ${meta.clipCount} clips` : "");
  const warnings = meta.warnings ?? [];
  const lines = [
    new Date(meta.at).toISOString().replace("T", " ").slice(0, 19) + " UTC",
    segmentsAndClips,
    `sources: local=${src.localCaptions} cloudShots=${src.cloudShots} cloudTimeline=${src.cloudTimeline} transcript=${src.transcript}`,
    directorLine(meta),
    captionsLine(meta),
    ...captionBreakdownLines(meta),
    ...musicLines(ctx, meta, WIDTH - pad * 2),
  ].filter((line): line is string => Boolean(line));
  // Warnings render in the existing "missing file" red rather than the
  // secondary gray, since the card's other overlay already uses that accent.
  const warningLines =
    warnings.length > 0 ? wrapText(ctx, `warnings: ${warnings.join("; ")}`, WIDTH - pad * 2, 2) : [];
  for (const line of lines) {
    ctx.fillStyle = "#a3a3a3";
    ctx.fillText(line, pad, y);
    y += 30;
  }
  if (warningLines.length > 0) {
    ctx.fillStyle = "#f87171";
    for (const line of warningLines) {
      ctx.fillText(line, pad, y);
      y += 30;
    }
  }
  y += 12;
  ctx.fillStyle = "#e5e5e5";
  ctx.font = "16px system-ui, sans-serif";
  for (const line of wrapText(ctx, `brief: ${meta.brief}`, WIDTH - pad * 2, 6)) {
    ctx.fillText(line, pad, y);
    y += 24;
  }
  if (sb.notes) {
    y += 8;
    ctx.fillStyle = "#a3a3a3";
    for (const line of wrapText(ctx, `director notes: ${sb.notes}`, WIDTH - pad * 2, 5)) {
      ctx.fillText(line, pad, y);
      y += 22;
    }
  }
}

async function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
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

async function waitMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return;
  return new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error(video.error?.message ?? "load error")), {
      once: true,
    });
  });
}

export async function exportDebugVideo(context: DebugExportContext): Promise<Blob> {
  const { storyboard, meta, activity, getFile, fileNameOf, onProgress } = context;
  const queriesByShot = searchQueriesByShot(activity);
  const banner = storyboard.title ?? "Untitled experiment";
  const badge = sourcesBadge(meta.promptSources);

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
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  // Fetch/decode the committed music bed BEFORE the recorder starts: the
  // download+decode can take seconds and must not become a dead zone at the
  // head of the recording. Loops for the whole render (it's a bed, not
  // synced to segments) into the same audioDest the segment audio uses; a
  // failure is surfaced as a title-card warning rather than dropping the run.
  let musicBedSource: AudioBufferSourceNode | null = null;
  let musicWarning: string | null = null;
  if (meta.music?.audioUrl) {
    onProgress?.("loading music bed…");
    try {
      const res = await fetch(meta.music.audioUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(buf);
      const gain = audioCtx.createGain();
      gain.gain.value = MUSIC_BED_VOLUME;
      musicBedSource = audioCtx.createBufferSource();
      musicBedSource.buffer = audioBuffer;
      musicBedSource.loop = true;
      musicBedSource.connect(gain).connect(audioDest);
    } catch (err) {
      musicWarning = "music audio failed to load — render has no bed";
      console.error("[debug-export] music bed failed to load", err);
    }
  }

  recorder.start(250);
  musicBedSource?.start();

  // Render clock. rAF stops entirely and main-thread timers clamp to 1Hz in
  // a backgrounded tab — which turned a tab switch mid-export into seconds
  // of frozen (or 1fps heartbeat) video under live audio. A Worker's timer
  // is exempt from that clamp, so ticks keep arriving at frame rate and the
  // export survives losing tab focus.
  const TICK_MS = Math.round(1000 / FPS);
  const tickerWorker = new Worker(
    URL.createObjectURL(
      new Blob([`setInterval(() => postMessage(0), ${TICK_MS});`], {
        type: "text/javascript",
      }),
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
    // gap (video metadata/seek between segments — seconds on 4K HEVC)
    // starves the video track. With a continuous music bed filling the audio
    // timeline, players render that starvation as a frozen decoder stall;
    // re-emitting the current pixels turns it into a clean, intentional hold
    // instead. Bed-less renders keep the old (documented-fine) behavior
    // where the muxer simply compresses the silent gaps away — hence the
    // musicBedSource gate.
    if (musicBedSource && performance.now() - lastPaintMs > TICK_MS * 1.5) {
      ctx.drawImage(canvas, 0, 0); // self-draw: same pixels, fresh frame
      markPaint();
    }
  };
  /** Run `fn` every frame tick until it returns true (then resolve). */
  const tickUntil = (fn: () => boolean) =>
    new Promise<void>((resolve) => {
      onTick = () => {
        if (fn()) {
          onTick = null;
          resolve();
        }
      };
    });

  /** Repaint every frame for `seconds` (captureStream needs canvas activity). */
  const holdFrame = (draw: () => void, seconds: number) => {
    const until = performance.now() + seconds * 1000;
    return tickUntil(() => {
      draw();
      markPaint();
      return performance.now() >= until;
    });
  };

  try {
    const cardMeta = musicWarning
      ? { ...meta, warnings: [...(meta.warnings ?? []), musicWarning] }
      : meta;

    onProgress?.("rendering title card…");
    await holdFrame(() => drawTitleCard(ctx, cardMeta, storyboard), TITLE_CARD_S);

    for (let i = 0; i < storyboard.items.length; i += 1) {
      const item = storyboard.items[i];
      const file = getFile(item.clipId);
      const fileName = fileNameOf(item.clipId);
      onProgress?.(`rendering segment ${i + 1}/${storyboard.items.length} (${fileName})…`);
      if (!file) {
        // Missing source file: hold an explanatory slate instead of failing.
        await holdFrame(() => {
          ctx.fillStyle = "#1a1a1a";
          ctx.fillRect(0, 0, WIDTH, HEIGHT);
          ctx.fillStyle = "#f87171";
          ctx.font = "24px ui-monospace, monospace";
          ctx.fillText(`missing file: ${fileName}`, 60, HEIGHT / 2);
          drawExperimentBanner(ctx, banner, badge);
          drawOverlay(ctx, item, i, storyboard.items.length, fileName, item.inS, []);
        }, 2);
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
        await seekTo(video, item.inS);
        source = audioCtx.createMediaElementSource(video);
        source.connect(audioDest); // graph-only: nothing reaches the speakers
        await video.play();

        const queries = queriesByShot.get(`${item.clipId}#${item.shotIndex ?? -1}`) ?? [];
        let playbackError: string | null = null;
        await tickUntil(() => {
          if (video.error) {
            playbackError = video.error.message ?? "playback error";
            return true;
          }
          ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);
          drawExperimentBanner(ctx, banner, badge);
          drawOverlay(
            ctx,
            item,
            i,
            storyboard.items.length,
            fileName,
            video.currentTime,
            queries,
          );
          markPaint();
          if (video.currentTime >= item.outS || video.ended) {
            video.pause();
            return true;
          }
          return false;
        });
        if (playbackError) throw new Error(playbackError);
      } finally {
        source?.disconnect();
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      }
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
    await done;
    await audioCtx.close().catch(() => undefined);
    stream.getTracks().forEach((t) => t.stop());
  }

  onProgress?.("finalizing…");
  return new Blob(chunks, { type: "video/webm" });
}

/** Trigger a browser download for an exported blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
