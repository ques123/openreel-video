import { useEffect, useRef, useState } from "react";
import type { Storyboard } from "@openreel/core";
import {
  listExperiments,
  loadExperiment,
  type DirectorExperiment,
  type ExperimentSummary,
} from "../../../services/experiments";

interface ExperimentMatrixModalProps {
  /** clipId -> File resolver for an experiment (cacheKey remap done upstream). */
  resolveGetFile: (exp: DirectorExperiment) => (clipId: string) => File | null;
  missingFiles: (exp: DirectorExperiment) => string[];
  onClose: () => void;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(5, 16);
}

/**
 * Compact live storyboard player for one matrix cell — plays the cut
 * directly from the original files (the "watch" path), so nothing needs a
 * debug render first.
 *
 * Playback intent is tracked explicitly (wantPlayingRef): storyboards span
 * MULTIPLE files, and each cross-file segment advance swaps the <video> src,
 * which silently stops playback — every boundary must re-issue play() or the
 * cut stalls mid-sequence. User pauses (controls / pause-all) clear the
 * intent; segment advances and src swaps must not.
 */
function StoryboardCellPlayer({
  storyboard,
  getFile,
}: {
  storyboard: Storyboard;
  getFile: (clipId: string) => File | null;
}) {
  const items = storyboard.items;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const advancedFromRef = useRef(-1);
  /** True while the cut SHOULD be playing (survives segment/file changes). */
  const wantPlayingRef = useRef(false);
  /** Suppress the pause events emitted by our own advance/finish machinery. */
  const systemPauseRef = useRef(false);

  const item = items[index];
  const file = item ? getFile(item.clipId) : null;

  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [file]);

  /** Seek to the current segment and resume iff the cut should be playing. */
  const seekIntoSegment = (v: HTMLVideoElement) => {
    v.currentTime = item.inS;
    if (wantPlayingRef.current) {
      v.play().catch(() => undefined);
    }
  };

  // Same-file segment change: the src did not swap, seek directly. (Cross-
  // file changes land in onLoadedMetadata once the new src has metadata.)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url || !item) return;
    systemPauseRef.current = false;
    if (v.readyState >= 1) seekIntoSegment(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, url]);

  // play-all support: parent dispatches "matrix-restart" on the video element.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const restart = () => {
      advancedFromRef.current = -1;
      wantPlayingRef.current = true;
      setDone(false);
      if (index === 0) {
        if (v.readyState >= 1) seekIntoSegment(v);
        // else: metadata still loading; onLoadedMetadata resumes for us.
      } else {
        systemPauseRef.current = true;
        setIndex(0);
      }
    };
    const hardPause = () => {
      wantPlayingRef.current = false;
      v.pause();
    };
    v.addEventListener("matrix-restart", restart);
    v.addEventListener("matrix-pause", hardPause);
    return () => {
      v.removeEventListener("matrix-restart", restart);
      v.removeEventListener("matrix-pause", hardPause);
    };
    // `url` is load-bearing: the <video> only mounts once the object URL
    // resolves, and without re-running this effect the listeners would attach
    // to nothing (videoRef was null on first pass) — play/pause-all dead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items, url]);

  if (!item) return null;

  return (
    <div className="relative">
      {url ? (
        <video
          ref={videoRef}
          src={url}
          controls
          playsInline
          data-matrix-video
          className="w-full aspect-video bg-black rounded object-contain"
          onLoadedMetadata={(e) => seekIntoSegment(e.currentTarget)}
          onPlay={() => {
            wantPlayingRef.current = true;
            setDone(false);
          }}
          onPause={(e) => {
            // Native-controls / pause-all pauses clear the intent; pauses we
            // caused ourselves (advance, finish) or seek hiccups do not.
            if (!systemPauseRef.current && !e.currentTarget.seeking) {
              wantPlayingRef.current = false;
            }
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (v.currentTime < item.outS - 0.05 || advancedFromRef.current === index) {
              return;
            }
            advancedFromRef.current = index;
            if (index + 1 < items.length) {
              systemPauseRef.current = true; // src swap may emit a pause
              setIndex(index + 1);
            } else {
              systemPauseRef.current = true;
              wantPlayingRef.current = false;
              v.pause();
              setDone(true);
            }
          }}
          onSeeked={(e) => {
            if (e.currentTarget.currentTime < item.outS - 0.05) {
              advancedFromRef.current = Math.min(advancedFromRef.current, index - 1);
            }
          }}
        />
      ) : (
        <div className="aspect-video bg-background rounded" />
      )}
      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-mono text-sky-300 pointer-events-none">
        {index + 1}/{items.length} · {item.role}
        {done && " · done"}
      </span>
    </div>
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
    {
      label: "captions",
      value: exp.captionModels ?? "?",
      common: uniform((e) => e.captionModels ?? "?"),
    },
  ];
}

/**
 * Cross-experiment comparison matrix: hand-pick experiments and watch their
 * cuts side by side, played LIVE from the original files (no debug render
 * needed). Settings + brief show under each cell with DIFFERENCES
 * highlighted — chips shared by every included experiment are dimmed;
 * whatever varies is what explains the videos differing.
 */
export function ExperimentMatrixModal({
  resolveGetFile,
  missingFiles,
  onClose,
}: ExperimentMatrixModalProps) {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [included, setIncluded] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<Record<string, DirectorExperiment>>({});
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listExperiments().then(setExperiments);
  }, []);

  // Load full records (storyboard, clip refs) for included experiments.
  useEffect(() => {
    for (const id of included) {
      if (loaded[id]) continue;
      void loadExperiment(id).then((exp) => {
        if (exp) setLoaded((m) => ({ ...m, [id]: exp }));
      });
    }
  }, [included, loaded]);

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
            {selected.length} of {experiments.length} included · live playback from source
            files · shared settings dimmed, differences highlighted
          </p>
          <div className="flex-1" />
          {selected.length > 0 && (
            <>
              <button
                className="px-2 py-0.5 text-xs rounded border border-border text-text-secondary hover:text-text-primary"
                onClick={() => {
                  for (const v of allVideos()) v.dispatchEvent(new Event("matrix-restart"));
                }}
              >
                ▶ play all
              </button>
              <button
                className="px-2 py-0.5 text-xs rounded border border-border text-text-secondary hover:text-text-primary"
                onClick={() => {
                  for (const v of allVideos()) v.dispatchEvent(new Event("matrix-pause"));
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
                    {fmtWhen(e.updatedAt)} · {e.itemCount} segs
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div ref={gridRef} className="flex-1 overflow-y-auto p-3">
            {selected.length === 0 ? (
              <p className="text-sm text-text-secondary p-6">
                Pick experiments on the left to compare their cuts side by side.
              </p>
            ) : (
              <div
                className={`grid gap-3 ${selected.length === 1 ? "grid-cols-1 max-w-3xl" : "grid-cols-2"}`}
              >
                {selected.map((e) => {
                  const exp = loaded[e.id];
                  const missing = exp ? missingFiles(exp) : [];
                  return (
                    <div key={e.id} className="border border-border rounded-lg p-2 space-y-1.5">
                      {!exp ? (
                        <div className="aspect-video bg-background rounded animate-pulse" />
                      ) : !exp.storyboard ? (
                        <div className="aspect-video bg-background rounded flex items-center justify-center text-xs text-text-secondary">
                          no storyboard stored
                        </div>
                      ) : missing.length > 0 ? (
                        <div className="aspect-video bg-background rounded flex items-center justify-center text-xs text-amber-500 text-center px-4">
                          re-add to compare: {missing.join(", ")}
                        </div>
                      ) : (
                        <StoryboardCellPlayer
                          storyboard={exp.storyboard}
                          getFile={resolveGetFile(exp)}
                        />
                      )}
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
                            title={
                              c.common
                                ? "same across all included"
                                : "differs between included experiments"
                            }
                          >
                            {c.label}={c.value}
                          </span>
                        ))}
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono border border-border text-text-secondary/60">
                          {e.itemCount} segs
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
