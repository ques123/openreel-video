import type { DenseCaption } from "@openreel/core";
import type { LabClip } from "../use-perception-lab";

interface SceneTimelinePanelProps {
  clips: LabClip[];
  onCaptionClick: (clip: LabClip, caption: DenseCaption) => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Every raw timestamped scene description — the unmerged source material
 * behind the director's SCENE TIMELINE. Grows live while the background
 * caption pass runs; shows the cloud-enhanced timeline when one exists.
 */
export function SceneTimelinePanel({ clips, onCaptionClick }: SceneTimelinePanelProps) {
  const withCaptions = clips.filter(
    (c) =>
      (c.dossier?.denseCaptions.length ?? 0) > 0 ||
      (c.dossier?.cloudDenseCaptions.length ?? 0) > 0 ||
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
            const cloud = clip.dossier?.cloudDenseCaptions ?? [];
            const captions = cloud.length > 0 ? cloud : (clip.dossier?.denseCaptions ?? []);
            return (
              <div key={clip.clipId}>
                <p className="text-xs font-medium text-text-secondary mb-1 truncate">
                  {clip.fileName}
                  <span className="font-normal ml-1.5">
                    {cloud.length > 0
                      ? `${captions.length} descriptions · cloud`
                      : clip.captionsTotal > 0 && clip.captionsDone < clip.captionsTotal
                        ? `describing ${clip.captionsDone}/${clip.captionsTotal}…`
                        : `${captions.length} descriptions`}
                  </span>
                </p>
                <ul className="space-y-0.5">
                  {captions.map((dc, i) => (
                    <li
                      key={i}
                      className="text-xs text-text-primary leading-relaxed hover:bg-background rounded px-1 py-0.5 cursor-pointer"
                      onClick={() => onCaptionClick(clip, dc)}
                    >
                      <span className="font-mono text-text-secondary mr-1.5">
                        {fmtTime(dc.t)}
                      </span>
                      {dc.text}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
