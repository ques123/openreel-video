import { useEffect } from "react";
import type { CloudRunMeta } from "@openreel/core";
import { captionNear, localCaptionsOf } from "../caption-views";
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

function fmtRun(run: CloudRunMeta | null): string {
  if (!run) return "not run";
  const parts = [`${run.framesSent} frames`];
  if (run.ms > 0) parts.push(`${(run.ms / 1000).toFixed(1)}s`);
  if (run.promptTokens > 0) {
    parts.push(`${((run.promptTokens + run.completionTokens) / 1000).toFixed(1)}k tokens`);
  }
  if (run.framesFailed > 0) parts.push(`${run.framesFailed} failed`);
  return parts.join(" · ");
}

/**
 * Side-by-side caption comparison: one row per sampled frame — the 512px
 * frame the models actually saw — with a column per caption variant that has
 * run (local, cloud shots, cloud timeline) and per-variant speed/cost stats
 * in the header. This is the "is the cloud pass worth it" view.
 */
export function CaptionCompareModal({ clip, onClose, onJumpTo }: CaptionCompareModalProps) {
  const dossier = clip.dossier;
  const frames = dossier?.denseFrames ?? [];
  const local = localCaptionsOf(dossier);
  // One column per archived (scope, model) run — different models COEXIST
  // over the same frames, which is exactly what this modal compares.
  const archive = [...(dossier?.cloudRunArchive ?? [])].sort((a, b) =>
    a.scope === b.scope ? a.model.localeCompare(b.model) : a.scope === "shots" ? -1 : 1,
  );

  const columns = [
    {
      key: "local",
      header: "local (on-device)",
      headerClass: "",
      stats: dossier?.localCaptionPerf
        ? `${local.length} captions · ${(dossier.localCaptionPerf.totalMs / Math.max(1, dossier.localCaptionPerf.frames) / 1000).toFixed(1)}s/frame`
        : `${local.length} captions`,
      lookup: (t: number) => captionNear(local, t, 1),
      empty: "—",
    },
    ...archive.map((entry) => ({
      key: `${entry.scope}:${entry.model}`,
      header: `${entry.scope === "shots" ? "shots" : "timeline"} · ${entry.model.replace("gpt-", "")}`,
      headerClass: "text-sky-600",
      stats: fmtRun(entry.meta),
      lookup: (t: number) => captionNear(entry.captions, t, entry.scope === "shots" ? 5 : 1),
      empty: "—",
    })),
  ];
  const gridTemplate = `10rem repeat(${columns.length}, minmax(220px, 1fr))`;

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
        className="bg-background-secondary border border-border rounded-xl overflow-hidden max-w-6xl w-full flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              {clip.fileName} — caption comparison
            </p>
            <p className="text-xs text-text-secondary">
              {frames.length} sampled frames
              {dossier?.cloudVision ? ` · cloud model: ${dossier.cloudVision.model}` : ""}
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

        <div className="overflow-auto">
        <div
          className="grid gap-x-3 px-4 py-1.5 text-[11px] border-b border-border min-w-fit sticky top-0 bg-background-secondary z-10"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          <span className="font-semibold text-text-secondary">frame</span>
          {columns.map((c) => (
            <span key={c.key}>
              <span className={`font-semibold ${c.headerClass || "text-text-secondary"}`}>
                {c.header}
              </span>
              <span className="block font-normal text-text-secondary/80">{c.stats}</span>
            </span>
          ))}
        </div>

        <div className="divide-y divide-border/50">
          {frames.map((frame) => (
            <div
              key={frame.t}
              className="grid gap-x-3 px-4 py-2 items-start min-w-fit"
              style={{ gridTemplateColumns: gridTemplate }}
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
              {columns.map((c) => (
                <p key={c.key} className="text-xs text-text-primary leading-relaxed">
                  {c.lookup(frame.t)?.text ?? (
                    <span className="text-text-secondary">{c.empty}</span>
                  )}
                </p>
              ))}
            </div>
          ))}
          {frames.length === 0 && (
            <p className="px-4 py-6 text-sm text-text-secondary">
              No sampled frames stored for this clip yet.
            </p>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
