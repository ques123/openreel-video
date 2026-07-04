import { useEffect, useRef, useState } from "react";
import {
  listExperiments,
  loadExperimentVideo,
  type ExperimentSummary,
} from "../../../services/experiments";

interface ExperimentMatrixModalProps {
  onClose: () => void;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(5, 16);
}

/** One stored-render player; owns its object URL (create+revoke in ONE effect). */
function MatrixVideo({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void loadExperimentVideo(id).then((blob) => {
      if (cancelled) return;
      if (!blob) {
        setMissing(true);
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  if (missing) {
    return (
      <div className="aspect-video bg-background rounded flex items-center justify-center text-xs text-text-secondary text-center px-4">
        no render stored — open the experiment and export a debug video first
      </div>
    );
  }
  return (
    <video
      src={url ?? undefined}
      controls
      playsInline
      data-matrix-video
      className="w-full aspect-video bg-black rounded"
    />
  );
}

interface SettingChip {
  label: string;
  value: string;
  /** True when every included experiment shares this value. */
  common: boolean;
}

function chipsFor(exp: ExperimentSummary, all: ExperimentSummary[]): SettingChip[] {
  const uniform = <T,>(get: (e: ExperimentSummary) => T) =>
    all.every((e) => get(e) === get(exp));
  const s = exp.promptSources;
  return [
    { label: "local", value: String(s.localCaptions), common: uniform((e) => e.promptSources.localCaptions) },
    { label: "c·shots", value: String(s.cloudShots), common: uniform((e) => e.promptSources.cloudShots) },
    { label: "c·timeline", value: String(s.cloudTimeline), common: uniform((e) => e.promptSources.cloudTimeline) },
    { label: "script", value: String(s.transcript), common: uniform((e) => e.promptSources.transcript) },
    {
      label: "target",
      value: exp.targetDurationS ? `${exp.targetDurationS}s` : "—",
      common: uniform((e) => e.targetDurationS ?? null),
    },
    { label: "model", value: exp.model, common: uniform((e) => e.model) },
  ];
}

/**
 * Cross-experiment comparison matrix: hand-pick experiments, watch their
 * stored debug renders side by side, and read the settings + brief with
 * DIFFERENCES highlighted (settings shared by every included experiment are
 * dimmed; whatever varies is what explains the videos differing).
 */
export function ExperimentMatrixModal({ onClose }: ExperimentMatrixModalProps) {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [included, setIncluded] = useState<string[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listExperiments().then(setExperiments);
  }, []);

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

  const selected = included
    .map((id) => experiments.find((e) => e.id === id))
    .filter((e): e is ExperimentSummary => !!e);

  const allVideos = () =>
    [...(gridRef.current?.querySelectorAll<HTMLVideoElement>("[data-matrix-video]") ?? [])];

  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex items-stretch justify-center p-4">
      <div
        className="bg-background-secondary border border-border rounded-xl overflow-hidden w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border">
          <p className="text-sm font-medium text-text-primary">Experiment comparison</p>
          <p className="text-xs text-text-secondary">
            {selected.length} of {experiments.length} included · shared settings dimmed,
            differences highlighted
          </p>
          <div className="flex-1" />
          {selected.length > 0 && (
            <>
              <button
                className="px-2 py-0.5 text-xs rounded border border-border text-text-secondary hover:text-text-primary"
                onClick={() => {
                  for (const v of allVideos()) {
                    v.currentTime = 0;
                    void v.play().catch(() => undefined);
                  }
                }}
              >
                ▶ play all
              </button>
              <button
                className="px-2 py-0.5 text-xs rounded border border-border text-text-secondary hover:text-text-primary"
                onClick={() => {
                  for (const v of allVideos()) v.pause();
                }}
              >
                ⏸ pause all
              </button>
            </>
          )}
          <button
            className="text-text-secondary hover:text-text-primary text-xl px-2"
            onClick={onClose}
            aria-label="Close comparison matrix"
          >
            ×
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-64 shrink-0 border-r border-border overflow-y-auto p-2 space-y-1">
            {experiments.length === 0 && (
              <p className="text-xs text-text-secondary p-2">No experiments yet.</p>
            )}
            {experiments.map((e) => (
              <label
                key={e.id}
                className="flex items-start gap-1.5 text-xs rounded px-1.5 py-1 hover:bg-background cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={included.includes(e.id)}
                  onChange={(ev) =>
                    setIncluded((list) =>
                      ev.target.checked ? [...list, e.id] : list.filter((id) => id !== e.id),
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="block text-text-primary truncate">
                    {e.title ?? e.brief.slice(0, 40)}
                  </span>
                  <span className="block text-text-secondary font-mono text-[10px]">
                    {fmtWhen(e.updatedAt)}
                    {e.videoAt ? " · render ✓" : " · no render"}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div ref={gridRef} className="flex-1 overflow-y-auto p-3">
            {selected.length === 0 ? (
              <p className="text-sm text-text-secondary p-6">
                Pick experiments on the left to compare their renders side by side.
              </p>
            ) : (
              <div
                className={`grid gap-3 ${selected.length === 1 ? "grid-cols-1 max-w-3xl" : "grid-cols-2"}`}
              >
                {selected.map((e) => (
                  <div key={e.id} className="border border-border rounded-lg p-2 space-y-1.5">
                    <MatrixVideo id={e.id} />
                    <p className="text-xs font-medium text-text-primary truncate">
                      {e.title ?? "(untitled)"}
                    </p>
                    <p
                      className="text-[11px] text-text-secondary leading-snug line-clamp-2"
                      title={e.brief}
                    >
                      {e.brief}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {chipsFor(e, selected).map((c) => (
                        <span
                          key={c.label}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                            c.common
                              ? "border-border text-text-secondary/60"
                              : "border-amber-500/60 text-amber-500"
                          }`}
                          title={c.common ? "same across all included" : "differs between included experiments"}
                        >
                          {c.label}={c.value}
                        </span>
                      ))}
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono border border-border text-text-secondary/60">
                        {e.itemCount} segs
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
