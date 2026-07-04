import { useEffect } from "react";
import { captionNear, cloudCaptionsOf, localCaptionsOf } from "../caption-views";
import type { LabClip } from "../use-perception-lab";

interface CaptionCompareModalProps {
  clip: LabClip;
  onClose: () => void;
  /** Open the video preview at this time (the modal closes itself first). */
  onJumpTo: (t: number) => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Side-by-side caption comparison: one row per sampled frame — the 512px
 * frame the models actually saw, the local description, and the cloud
 * description of the same moment. This is the "is the cloud pass worth it"
 * view.
 */
export function CaptionCompareModal({ clip, onClose, onJumpTo }: CaptionCompareModalProps) {
  const dossier = clip.dossier;
  const frames = dossier?.denseFrames ?? [];
  const local = localCaptionsOf(dossier);
  const cloud = cloudCaptionsOf(dossier);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-background-secondary border border-border rounded-xl overflow-hidden max-w-5xl w-full flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              {clip.fileName} — caption comparison
            </p>
            <p className="text-xs text-text-secondary">
              {frames.length} sampled frames · local: FastVLM on-device
              {dossier?.cloudVision
                ? ` · cloud: ${dossier.cloudVision.model} (${dossier.cloudVision.scope} scope, ${cloud.length} description${cloud.length === 1 ? "" : "s"})`
                : " · no cloud enhance yet"}
            </p>
          </div>
          <button
            className="text-text-secondary hover:text-text-primary text-xl px-2"
            onClick={onClose}
            aria-label="Close comparison"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-[10rem_1fr_1fr] gap-x-3 px-4 py-1.5 text-[11px] font-semibold text-text-secondary border-b border-border">
          <span>frame</span>
          <span>local (on-device)</span>
          <span className="text-sky-600">cloud</span>
        </div>

        <div className="overflow-y-auto divide-y divide-border/50">
          {frames.map((frame) => {
            const l = captionNear(local, frame.t, 1);
            const c = captionNear(cloud, frame.t, 5);
            return (
              <div
                key={frame.t}
                className="grid grid-cols-[10rem_1fr_1fr] gap-x-3 px-4 py-2 items-start"
              >
                <div
                  className="cursor-pointer group"
                  onClick={() => onJumpTo(frame.t)}
                  title="Play the clip from this moment"
                >
                  <img
                    src={frame.dataUrl}
                    alt={`frame at ${fmtTime(frame.t)}`}
                    className="w-40 aspect-video object-cover rounded bg-black group-hover:ring-2 ring-primary"
                    draggable={false}
                  />
                  <p className="text-[10px] font-mono text-text-secondary mt-0.5">
                    {fmtTime(frame.t)} ▶
                  </p>
                </div>
                <p className="text-xs text-text-primary leading-relaxed">
                  {l?.text ?? <span className="text-text-secondary">—</span>}
                </p>
                <p className="text-xs text-text-primary leading-relaxed">
                  {c?.text ?? (
                    <span className="text-text-secondary">
                      {cloud.length === 0 ? "— (not enhanced)" : "—"}
                    </span>
                  )}
                </p>
              </div>
            );
          })}
          {frames.length === 0 && (
            <p className="px-4 py-6 text-sm text-text-secondary">
              No sampled frames stored for this clip yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
