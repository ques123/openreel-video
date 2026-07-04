import { useState } from "react";
import type { DenseCaption } from "@openreel/core";
import { cloudCaptionsOf } from "../caption-views";
import type { LabClip } from "../use-perception-lab";

interface SceneTimelinePanelProps {
  clips: LabClip[];
  onCaptionClick: (clip: LabClip, caption: DenseCaption) => void;
  /** Open the side-by-side frame/local/cloud comparison for a clip. */
  onCompare: (clip: LabClip) => void;
}

type View = "local" | "cloud";

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Every raw timestamped scene description — the unmerged source material
 * behind the director's SCENE TIMELINE. Grows live while the background
 * caption pass runs. Clips with a cloud enhance get local/cloud tabs;
 * the cloud view pairs each row with the local description of the same
 * moment so the two models can be compared directly.
 */
export function SceneTimelinePanel({ clips, onCaptionClick, onCompare }: SceneTimelinePanelProps) {
  // Per-clip view override; without one, clips with cloud data open on the
  // cloud view (so a finished enhance is immediately visible).
  const [viewByClip, setViewByClip] = useState<Record<string, View>>({});

  const withCaptions = clips.filter(
    (c) =>
      (c.dossier?.denseCaptions.length ?? 0) > 0 ||
      cloudCaptionsOf(c.dossier).length > 0 ||
      c.captionsTotal > 0,
  );

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Scene timeline</h3>
      {withCaptions.length === 0 ? (
        <p className="text-xs text-text-secondary">
          No scene descriptions yet. The local vision model describes sampled
          frames after each clip's analysis finishes.
        </p>
      ) : (
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {withCaptions.map((clip) => {
            const local = clip.dossier?.denseCaptions ?? [];
            const cloud = cloudCaptionsOf(clip.dossier);
            const view: View =
              viewByClip[clip.clipId] ?? (cloud.length > 0 ? "cloud" : "local");
            const captions = view === "cloud" ? cloud : local;
            // For the compare line under cloud rows: local caption at (or
            // nearest to) the same timestamp, within a sampling gap.
            const localAt = (t: number): DenseCaption | null => {
              let best: DenseCaption | null = null;
              for (const c of local) {
                if (Math.abs(c.t - t) > 5) continue;
                if (!best || Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
              }
              return best;
            };
            return (
              <div key={clip.clipId}>
                <p className="text-xs font-medium text-text-secondary mb-1 truncate flex items-center gap-1.5">
                  <span className="truncate">{clip.fileName}</span>
                  <span className="font-normal shrink-0">
                    {clip.captionsTotal > 0 && clip.captionsDone < clip.captionsTotal
                      ? `describing ${clip.captionsDone}/${clip.captionsTotal}…`
                      : `${captions.length} description${captions.length === 1 ? "" : "s"}`}
                  </span>
                  {cloud.length > 0 && (
                    <span className="shrink-0 inline-flex rounded border border-border overflow-hidden">
                      {(["local", "cloud"] as const).map((v) => (
                        <button
                          key={v}
                          className={`px-1.5 py-0.5 font-normal ${
                            view === v
                              ? "bg-sky-500/20 text-sky-600"
                              : "text-text-secondary hover:bg-background"
                          }`}
                          onClick={() =>
                            setViewByClip((m) => ({ ...m, [clip.clipId]: v }))
                          }
                        >
                          {v}
                        </button>
                      ))}
                    </span>
                  )}
                  {cloud.length > 0 && (
                    <button
                      className="shrink-0 px-1.5 py-0.5 font-normal rounded border border-border text-text-secondary hover:bg-background"
                      onClick={() => onCompare(clip)}
                      title="Side-by-side: frame, local caption, cloud caption"
                    >
                      compare ⇆
                    </button>
                  )}
                </p>
                <ul className="space-y-0.5">
                  {captions.map((dc, i) => {
                    const paired = view === "cloud" ? localAt(dc.t) : null;
                    return (
                      <li
                        key={i}
                        className="text-xs text-text-primary leading-relaxed hover:bg-background rounded px-1 py-0.5 cursor-pointer"
                        onClick={() => onCaptionClick(clip, dc)}
                      >
                        <span className="font-mono text-text-secondary mr-1.5">
                          {fmtTime(dc.t)}
                        </span>
                        {dc.text}
                        {paired && (
                          <span className="block pl-4 text-text-secondary/80">
                            <span className="italic mr-1">local:</span>
                            {paired.text}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
