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

import type { DirectorActivity, PromptSources, Storyboard, StoryboardItem } from "@openreel/core";

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
 * settings — so side-by-side comparisons stay identifiable frame one.
 */
function drawExperimentBanner(
  ctx: CanvasRenderingContext2D,
  title: string,
  badge: string,
): void {
  const h = 34;
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  ctx.fillRect(0, 0, WIDTH, h);
  ctx.font = "600 17px ui-monospace, monospace";
  ctx.fillStyle = "#7dd3fc";
  const titleText = title.length > 70 ? title.slice(0, 67) + "…" : title;
  ctx.fillText(titleText, 14, 23);
  const tw = ctx.measureText(titleText).width;
  ctx.fillStyle = "#a3a3a3";
  ctx.font = "15px ui-monospace, monospace";
  ctx.fillText("· " + badge, 14 + tw + 10, 23);
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
  const lines = [
    new Date(meta.at).toISOString().replace("T", " ").slice(0, 19) + " UTC",
    `model ${meta.model}  ·  target ${meta.targetDurationS ? fmtS(meta.targetDurationS) : "none"}  ·  ${sb.items.length} segments`,
    `sources: local=${src.localCaptions} cloudShots=${src.cloudShots} cloudTimeline=${src.cloudTimeline} transcript=${src.transcript}`,
    meta.usage
      ? `llm usage: ${meta.usage.calls} calls, ${((meta.usage.promptTokens + meta.usage.completionTokens) / 1000).toFixed(1)}k tokens`
      : "",
  ].filter(Boolean);
  for (const line of lines) {
    ctx.fillText(line, pad, y);
    y += 30;
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
  recorder.start(250);

  /** Repaint every frame for `seconds` (captureStream needs canvas activity). */
  const holdFrame = (draw: () => void, seconds: number) =>
    new Promise<void>((resolve) => {
      const until = performance.now() + seconds * 1000;
      const tick = () => {
        draw();
        if (performance.now() < until) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

  try {
    onProgress?.("rendering title card…");
    await holdFrame(() => drawTitleCard(ctx, meta, storyboard), TITLE_CARD_S);

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
        await new Promise<void>((resolve, reject) => {
          const tick = () => {
            if (video.error) {
              reject(new Error(video.error.message ?? "playback error"));
              return;
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
            if (video.currentTime >= item.outS || video.ended) {
              video.pause();
              resolve();
            } else {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        });
      } finally {
        source?.disconnect();
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      }
    }
  } finally {
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
