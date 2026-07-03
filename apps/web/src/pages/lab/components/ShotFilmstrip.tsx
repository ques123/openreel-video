import type { Shot } from "@openreel/core";
import type { LabClip } from "../use-perception-lab";

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
  onShotClick?: (shot: Shot) => void;
  /** Non-null when the cloud-vision toggle is on: clicking sends frames. */
  onEnhance?: (() => void) | null;
}

export function ShotFilmstrip({ clip, highlights, onShotClick, onEnhance }: ShotFilmstripProps) {
  const analysisSpanS = clip.analyzedThroughS ?? clip.durationS;
  const progress = analysisSpanS > 0 ? Math.min(1, clip.decodeT / analysisSpanS) : 0;

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-text-primary truncate">{clip.fileName}</span>
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
          {clip.cloud?.busy && (
            <span className="text-xs text-sky-600">
              enhancing… {clip.cloud.done}/{clip.cloud.total} frames
            </span>
          )}
          {clip.cloud?.error && (
            <span className="text-xs text-red-400" title={clip.cloud.error}>
              cloud failed
            </span>
          )}
          {onEnhance && clip.status === "done" && !clip.cloud?.busy && (
            <button
              className="text-xs px-1.5 py-0.5 rounded border border-sky-500/50 text-sky-600 hover:bg-sky-500/10"
              onClick={onEnhance}
              title="Send this clip's sampled frames to the cloud vision model for much better descriptions"
            >
              {clip.dossier?.cloudVision ? "re-enhance" : "enhance"}
            </button>
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

      <div className="flex gap-2 overflow-x-auto pb-1">
        {clip.shots.map((shot) => {
          const hitScore = highlights.get(shot.index);
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
                shot.cloudCaption ?? shot.caption
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
