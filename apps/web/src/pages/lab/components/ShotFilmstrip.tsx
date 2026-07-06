import { useLayoutEffect, useRef } from "react";
import type { CandidatePick, Shot } from "@openreel/core";
import type { LabClip } from "../use-perception-lab";
import {
  STRIP_VIEWPORT_MARGIN_PX,
  intersectionObserverSupported,
  placeholderStripHeightPx,
  recordStripHeight,
  shouldRenderShotCards,
  useNearViewport,
} from "./strip-visibility";

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

/** Motion score buckets for the badge (mean |deltaY|, 0..255 scale). */
function motionBadge(score: number): string {
  if (score > 12) return "●●●";
  if (score > 5) return "●●○";
  return "●○○";
}

interface ShotFilmstripProps {
  clip: LabClip;
  /** shot indices highlighted by search, mapped to score. */
  highlights: Map<number, number>;
  /** Selector candidate picks for this clip's shots, keyed by shot index. */
  picks?: Map<number, CandidatePick>;
  onShotClick?: (shot: Shot) => void;
  /** Non-null when the cloud-vision toggle is on: clicking sends frames. */
  onEnhance?: (() => void) | null;
  /**
   * When set, the Enhance button still renders (cloud vision is on) but is
   * disabled with this as the tooltip — e.g. candidates-only mode and this
   * clip has no candidate shots to send.
   */
  enhanceDisabledReason?: string | null;
  /** Open the side-by-side frame/local/cloud caption comparison. */
  onCompare?: () => void;
  /**
   * Optional cost figure rendered next to the Enhance button (pure display,
   * e.g. "≈$0.03 · 24 frames" from enhance-cost.ts's formatCostPreview) —
   * the page owns the math.
   */
  enhanceCostLabel?: string | null;
  /** Non-null when bulk-enhance selection is active: this clip's checkbox state. */
  selected?: boolean | null;
  onSelectChange?: (checked: boolean) => void;
}

export function ShotFilmstrip({
  clip,
  highlights,
  picks,
  onShotClick,
  onEnhance,
  enhanceDisabledReason,
  onCompare,
  enhanceCostLabel,
  selected = null,
  onSelectChange,
}: ShotFilmstripProps) {
  const analysisSpanS = clip.analyzedThroughS ?? clip.durationS;
  const progress = analysisSpanS > 0 ? Math.min(1, clip.decodeT / analysisSpanS) : 0;
  // A cache hit only carries proxyName via the dossier (re-dropping just the
  // original this session never repopulates clip.proxyName, which is set at
  // drop-time pairing only) — check both.
  const proxyName = clip.proxyName ?? clip.dossier?.analyzedFromProxy ?? null;

  // Viewport gating (see strip-visibility.ts): render the thumbnail <img>s
  // only while the strip is within ~a screen of the viewport; empty same-size
  // cells otherwise, so scroll geometry and the shot anchor ids stay stable.
  const [rootRef, nearViewport] = useNearViewport<HTMLDivElement>(STRIP_VIEWPORT_MARGIN_PX);
  const showShotCards = shouldRenderShotCards({
    shotCount: clip.shots.length,
    observerSupported: intersectionObserverSupported(),
    nearViewport,
  });
  const stripRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Record the rendered row's height so offscreen placeholders match it
    // exactly (all strips share the same card CSS).
    if (showShotCards && clip.shots.length > 0 && stripRef.current) {
      recordStripHeight(stripRef.current.offsetHeight);
    }
  }, [showShotCards, clip.shots.length]);

  return (
    <div ref={rootRef} className="bg-background-secondary border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {selected !== null && clip.status === "done" && (
            <input
              type="checkbox"
              className="shrink-0 accent-sky-600"
              checked={selected}
              onChange={(e) => onSelectChange?.(e.target.checked)}
              title="Include this clip in 'enhance selected'"
            />
          )}
          <span className="font-medium text-text-primary truncate">{clip.fileName}</span>
          {proxyName && (
            <span
              className="text-[10px] px-1 rounded border border-sky-500/60 text-sky-500 shrink-0"
              title={`analyzed from ${proxyName} (720p sidecar) — playback & export use the original file`}
            >
              via proxy
            </span>
          )}
          <span className="text-xs text-text-secondary shrink-0">
            {clip.width > 0 && `${clip.width}×${clip.height} · `}
            {clip.durationS > 0 && `${fmtTime(clip.durationS)} · `}
            {(clip.fileSize / 1e6).toFixed(0)}MB
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {clip.dossier?.cloudVision && !clip.cloud?.busy && (
            <span
              className="text-xs px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-600"
              title={`Cloud-enhanced (${clip.dossier.cloudVision.scope}, ${clip.dossier.cloudVision.model})`}
            >
              cloud ✓
            </span>
          )}
          {onCompare && clip.dossier?.cloudVision && !clip.cloud?.busy && (
            <button
              className="text-xs px-1.5 py-0.5 rounded border border-border text-text-secondary hover:bg-background"
              onClick={onCompare}
              title="Side-by-side: frame, local caption, cloud caption"
            >
              compare ⇆
            </button>
          )}
          {clip.cloud?.busy && (
            <span className="text-xs text-sky-600">
              enhancing… {clip.cloud.done}/{clip.cloud.total} frames
              {clip.cloud.outOfCandidateRanges ? (
                <span className="text-text-secondary">
                  {" "}
                  · {clip.cloud.outOfCandidateRanges} frames outside candidates skipped
                </span>
              ) : null}
            </span>
          )}
          {clip.cloud?.error && (
            <span className="text-xs text-red-400" title={clip.cloud.error}>
              cloud failed
            </span>
          )}
          {onEnhance && clip.status === "done" && !clip.cloud?.busy && (
            <>
              {enhanceCostLabel && !enhanceDisabledReason && (
                <span
                  className="text-xs text-text-secondary"
                  title="Estimated before anything is sent: measured per-frame token profile × current model pricing"
                >
                  {enhanceCostLabel}
                </span>
              )}
              <button
                className="text-xs px-1.5 py-0.5 rounded border border-sky-500/50 text-sky-600 hover:bg-sky-500/10 disabled:opacity-40 disabled:cursor-default"
                onClick={enhanceDisabledReason ? undefined : onEnhance}
                disabled={!!enhanceDisabledReason}
                title={
                  enhanceDisabledReason ??
                  "Send this clip's sampled frames to the cloud vision model for much better descriptions"
                }
              >
                {clip.dossier?.cloudVision ? "re-enhance" : "enhance"}
              </button>
            </>
          )}
          {clip.dossier?.perf.cacheHit && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">
              cached
            </span>
          )}
          {clip.analyzedThroughS !== null && (
            <span
              className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-600"
              title="File exceeds the browser's storage quota — only the first part was analyzed"
            >
              partial · first {fmtTime(clip.analyzedThroughS)} of {fmtTime(clip.durationS)}
            </span>
          )}
          {clip.status === "analyzing" && (
            <span className="text-xs text-text-secondary">
              {clip.ingestProgress !== null
                ? `ingesting… ${Math.round(clip.ingestProgress * 100)}%`
                : `analyzing… ${Math.round(progress * 100)}%`}
            </span>
          )}
          {clip.status === "analyzing" && clip.ingestWindow && clip.ingestWindow.windows > 1 && (
            <span
              className="text-xs font-mono text-text-secondary"
              title="long clip — analyzed in storage-sized passes; nothing is skipped"
            >
              pass {clip.ingestWindow.window}/{clip.ingestWindow.windows} ·{" "}
              {fmtTime(clip.ingestWindow.analyzedThroughS)} covered
            </span>
          )}
          {clip.status === "error" && (
            <span className="text-xs text-red-400" title={clip.error}>
              error: {clip.error}
            </span>
          )}
          <span className="text-xs text-text-secondary">
            {clip.shots.length} shot{clip.shots.length === 1 ? "" : "s"}
            {clip.shots.length > 0 && ` · ${clip.embeddedCount} embedded`}
            {clip.captionsTotal > 0 &&
              (clip.captionsDone < clip.captionsTotal
                ? ` · describing ${clip.captionsDone}/${clip.captionsTotal}`
                : ` · ${clip.captionsTotal} descriptions`)}
          </span>
        </div>
      </div>

      {clip.status === "analyzing" && (
        <div className="h-1 bg-background rounded overflow-hidden mb-2">
          <div
            className={`h-full transition-all ${
              clip.ingestProgress !== null ? "bg-text-secondary/50" : "bg-primary"
            }`}
            style={{
              width: `${(clip.ingestProgress !== null ? clip.ingestProgress : progress) * 100}%`,
            }}
          />
        </div>
      )}

      <div
        ref={stripRef}
        className="flex gap-2 overflow-x-auto pb-1"
        style={showShotCards ? undefined : { height: placeholderStripHeightPx() }}
      >
        {!showShotCards &&
          // Offscreen: one empty cell per shot keeps the row's width/height
          // and the `shot-…` anchor ids (scrollIntoView targets) without
          // mounting any of the base64 thumbnails.
          clip.shots.map((shot) => (
            <div
              key={shot.index}
              id={`shot-${clip.clipId}-${shot.index}`}
              className="shrink-0 w-36 rounded-md bg-background"
              aria-hidden
            />
          ))}
        {showShotCards &&
          clip.shots.map((shot) => {
            const hitScore = highlights.get(shot.index);
            const pick = picks?.get(shot.index);
            return (
              <div
                key={shot.index}
                id={`shot-${clip.clipId}-${shot.index}`}
                className={`shrink-0 w-36 rounded-md overflow-hidden border-2 transition-colors cursor-pointer ${
                  hitScore !== undefined
                    ? "border-primary shadow-lg shadow-primary/30"
                    : "border-transparent hover:border-border"
                }`}
                onClick={() => onShotClick?.(shot)}
                title={`shot ${shot.index} · ${fmtTime(shot.tStart)}–${fmtTime(shot.tEnd)}${
                  shot.cloudCaption && shot.caption
                    ? `\ncloud: ${shot.cloudCaption}\nlocal: ${shot.caption}`
                    : shot.cloudCaption ?? shot.caption
                      ? `\n${shot.cloudCaption ?? shot.caption}`
                      : ""
                }`}
              >
                <div className="relative">
                  <img
                    src={shot.thumbnailDataUrl}
                    alt={`shot ${shot.index}`}
                    className="w-full aspect-video object-cover bg-black"
                    draggable={false}
                  />
                  {hitScore !== undefined && (
                    <span className="absolute top-1 right-1 text-[10px] font-mono px-1 rounded bg-primary text-white">
                      {hitScore.toFixed(2)}
                    </span>
                  )}
                  {pick && (
                    <span
                      className="absolute top-1 left-1 text-[10px] font-mono px-1 rounded bg-amber-500/90 text-black"
                      title={
                        pick.reasons.join(", ") +
                        (pick.uniquenessPenalty > 0
                          ? ` (uniqueness −${pick.uniquenessPenalty.toFixed(2)})`
                          : "")
                      }
                    >
                      ★{pick.rank}
                    </span>
                  )}
                  {!shot.embedding && clip.status !== "error" && (
                    <span className="absolute bottom-1 right-1 text-[10px] px-1 rounded bg-black/60 text-white/70">
                      embedding…
                    </span>
                  )}
                </div>
                <div className="px-1.5 py-1 bg-background text-[10px] text-text-secondary flex items-center justify-between">
                  <span className="font-mono">
                    {fmtTime(shot.tStart)}–{fmtTime(shot.tEnd)}
                  </span>
                  <span title={`motion ${shot.motion.score.toFixed(1)}`}>
                    {motionBadge(shot.motion.score)}
                  </span>
                  <span title={`sharpness ${shot.quality.sharpness.toFixed(0)}`}>
                    {shot.quality.sharpness > 200 ? "sharp" : "soft"}
                  </span>
                </div>
              </div>
            );
          })}
        {clip.shots.length === 0 && clip.status === "analyzing" && (
          <div className="text-xs text-text-secondary py-6 px-2">
            decoding & watching for shots…
          </div>
        )}
      </div>
    </div>
  );
}
