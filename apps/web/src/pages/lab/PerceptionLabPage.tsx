import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CloudScope,
  DenseCaption,
  SearchHit,
  Shot,
  Storyboard,
  TranscriptSegment,
} from "@openreel/core";
import { CAPTION_MODELS, type CaptionModel } from "../../services/cloud-vision";
import { downloadBlob, exportDebugVideo } from "../../services/debug-export";
import { saveExperimentVideo, type DirectorExperiment } from "../../services/experiments";
import { useRouter } from "../../hooks/use-router";
import { cloudShotCaptionsOf, cloudTimelineCaptionsOf, localCaptionsOf } from "./caption-views";
import { CaptionCompareModal } from "./components/CaptionCompareModal";
import { ClipDropZone } from "./components/ClipDropZone";
import { DirectorPanel } from "./components/DirectorPanel";
import { ExperimentDetailModal } from "./components/ExperimentDetailModal";
import { ExperimentMatrixModal } from "./components/ExperimentMatrixModal";
import { ExperimentsPanel } from "./components/ExperimentsPanel";
import { PerfPanel } from "./components/PerfPanel";
import { SceneTimelinePanel } from "./components/SceneTimelinePanel";
import { SearchPanel } from "./components/SearchPanel";
import { ShotFilmstrip } from "./components/ShotFilmstrip";
import { ShotPreviewModal, type ShotPreview } from "./components/ShotPreviewModal";
import { StoryboardList } from "./components/StoryboardList";
import { StoryboardPreviewModal } from "./components/StoryboardPreviewModal";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { useDirector } from "./use-director";
import { usePerceptionLab, type LabClip } from "./use-perception-lab";

export function PerceptionLabPage() {
  const { params } = useRouter();
  const forceDevice = params.device === "wasm" ? "wasm" : "auto";
  const { state, addFiles, runSearch, getFile, getDossiers, embedQuery, enhanceClip } =
    usePerceptionLab(forceDevice);
  const director = useDirector({ getDossiers, embedQuery });
  const [preview, setPreview] = useState<ShotPreview | null>(null);
  /** Segment index to start storyboard playback from; null = closed. */
  const [storyboardStart, setStoryboardStart] = useState<number | null>(null);
  /** Clip whose side-by-side caption comparison is open; null = closed. */
  const [compareClip, setCompareClip] = useState<LabClip | null>(null);
  /** Stored experiment being inspected; null = closed. */
  const [experimentOpen, setExperimentOpen] = useState<string | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [experimentsRefresh, setExperimentsRefresh] = useState(0);
  /** Live progress line while a debug export renders; null = idle. */
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  /** Replay of a stored experiment's cut (storyboard + remapped files). */
  const [replay, setReplay] = useState<{
    storyboard: Storyboard;
    getFile: (clipId: string) => File | null;
  } | null>(null);
  // Cloud vision opt-in: session-only (deliberately NOT persisted — each
  // session re-consents) + per-run scope dial.
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [cloudScope, setCloudScope] = useState<CloudScope>("shots");
  const [cloudModel, setCloudModel] = useState<CaptionModel>("gpt-5.2");
  /**
   * Bulk-enhance selection overrides. Default (no entry): a clip is selected
   * unless it already has a cloud enhance — so "enhance selected" is
   * enhance-everything-new out of the box, without silently re-billing
   * already-enhanced clips.
   */
  const [selectedOverride, setSelectedOverride] = useState<Record<string, boolean>>({});
  const [bulkRunning, setBulkRunning] = useState(false);

  const isSelected = useCallback(
    (clip: LabClip) => selectedOverride[clip.clipId] ?? !clip.dossier?.cloudRuns?.[cloudScope],
    [selectedOverride, cloudScope],
  );

  const selectedClips = state.clips.filter(
    (c) => c.status === "done" && !c.cloud?.busy && isSelected(c),
  );

  /** Master selection: explicit all/none, from which any subset is a few clicks. */
  const setAllSelected = useCallback(
    (checked: boolean) => {
      setSelectedOverride((m) => {
        const next = { ...m };
        for (const c of state.clips) {
          if (c.status === "done") next[c.clipId] = checked;
        }
        return next;
      });
    },
    [state.clips],
  );

  /** Caption timelines for the preview modal's playhead-synced header. */
  const timelinesFor = useCallback(
    (clip: LabClip | undefined) =>
      clip?.dossier
        ? {
            local: localCaptionsOf(clip.dossier),
            "cloud-shots": cloudShotCaptionsOf(clip.dossier),
            "cloud-timeline": cloudTimelineCaptionsOf(clip.dossier),
          }
        : undefined,
    [],
  );

  const openPreview = useCallback(
    (clipId: string, fileName: string, shot: Shot) => {
      const file = getFile(clipId);
      if (!file) return;
      const clip = state.clips.find((c) => c.clipId === clipId);
      setPreview({ file, fileName, shot, timelines: timelinesFor(clip) });
    },
    [getFile, state.clips, timelinesFor],
  );

  // clipId -> (shotIndex -> score) for filmstrip highlights (confident only —
  // highlighting every top-K hit made weak matches look like real ones).
  const highlightsByClip = useMemo(() => {
    const map = new Map<string, Map<number, number>>();
    for (const hit of state.search.hits) {
      if (!hit.confident) continue;
      let clipMap = map.get(hit.clipId);
      if (!clipMap) {
        clipMap = new Map();
        map.set(hit.clipId, clipMap);
      }
      clipMap.set(hit.shot.index, hit.score);
    }
    return map;
  }, [state.search.hits]);

  const scrollToShot = useCallback((clipId: string, shotIndex: number) => {
    document
      .getElementById(`shot-${clipId}-${shotIndex}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }, []);

  const handleHitClick = useCallback(
    (hit: SearchHit) => {
      scrollToShot(hit.clipId, hit.shot.index);
      openPreview(hit.clipId, hit.fileName, hit.shot);
    },
    [scrollToShot, openPreview],
  );

  const handleSegmentClick = useCallback(
    (clip: LabClip, segment: TranscriptSegment) => {
      const shot = clip.shots.find((s) => segment.t0 >= s.tStart && segment.t0 < s.tEnd);
      if (shot) {
        scrollToShot(clip.clipId, shot.index);
        openPreview(clip.clipId, clip.fileName, shot);
      }
    },
    [scrollToShot, openPreview],
  );

  /** Open the preview seeked to a moment (shot = containing, else nearest). */
  const openPreviewAt = useCallback(
    (clip: LabClip, t: number, caption?: string) => {
      const file = getFile(clip.clipId);
      if (!file) return;
      const shot =
        clip.shots.find((s) => t >= s.tStart && t < s.tEnd) ??
        clip.shots.reduce<Shot | null>(
          (best, s) =>
            !best ||
            Math.abs(t - (s.tStart + s.tEnd) / 2) <
              Math.abs(t - (best.tStart + best.tEnd) / 2)
              ? s
              : best,
          null,
        );
      if (!shot) return;
      scrollToShot(clip.clipId, shot.index);
      setPreview({
        file,
        fileName: clip.fileName,
        shot,
        startAtS: t,
        caption,
        timelines: timelinesFor(clip),
      });
    },
    [getFile, scrollToShot, timelinesFor],
  );

  const handleCaptionClick = useCallback(
    (clip: LabClip, dc: DenseCaption) => openPreviewAt(clip, dc.t, dc.text),
    [openPreviewAt],
  );

  // Refresh the experiments list whenever a run lands or updates.
  useEffect(() => {
    if (director.state.phase === "awaiting-refine") {
      setExperimentsRefresh((n) => n + 1);
    }
  }, [director.state.phase, director.state.messages]);

  /** Find a clip's File in THIS session by its stable cross-session identity. */
  const fileByCacheKey = useCallback(
    (cacheKey: string) => {
      const clip = state.clips.find((c) => c.dossier?.cacheKey === cacheKey);
      return clip ? getFile(clip.clipId) : null;
    },
    [state.clips, getFile],
  );

  /** clipId -> File resolver for an experiment (old ids remapped via cacheKey). */
  const experimentGetFile = useCallback(
    (exp: DirectorExperiment) => (clipId: string) => {
      const ref = exp.clips.find((c) => c.clipId === clipId);
      return (ref ? fileByCacheKey(ref.cacheKey) : null) ?? getFile(clipId);
    },
    [fileByCacheKey, getFile],
  );

  const experimentMissingFiles = useCallback(
    (exp: DirectorExperiment) =>
      exp.clips.filter((ref) => !fileByCacheKey(ref.cacheKey)).map((r) => r.fileName),
    [fileByCacheKey],
  );

  /** Render + download the debug WebM for an experiment's storyboard. */
  const runDebugExport = useCallback(
    async (exp: DirectorExperiment, storyboard: Storyboard) => {
      if (exportProgress !== null) return;
      setExportProgress("starting…");
      try {
        const blob = await exportDebugVideo({
          storyboard,
          meta: {
            brief: exp.brief,
            targetDurationS: exp.targetDurationS,
            promptSources: exp.promptSources,
            model: exp.model,
            at: exp.at,
            usage: exp.usage,
            durationMs: exp.durationMs,
            clipCount: exp.clips.length,
            captionModels: exp.captionModels,
            captionStats: exp.captionStats,
            warnings: exp.warnings,
          },
          activity: exp.activity,
          getFile: experimentGetFile(exp),
          fileNameOf: (clipId) =>
            exp.clips.find((c) => c.clipId === clipId)?.fileName ??
            state.clips.find((c) => c.clipId === clipId)?.fileName ??
            clipId,
          onProgress: setExportProgress,
        });
        const slug = (storyboard.title ?? "cut").replace(/\W+/g, "-").toLowerCase();
        // Persist the render so the comparison matrix replays it without
        // re-rendering (and without needing the source files present).
        await saveExperimentVideo(exp.id, blob).catch(() => undefined);
        setExperimentsRefresh((n) => n + 1);
        downloadBlob(blob, `debug-${slug}-${exp.id}.webm`);
      } catch (err) {
        console.error("[debug-export]", err);
        window.alert(
          "Debug export failed: " + (err instanceof Error ? err.message : String(err)),
        );
      } finally {
        setExportProgress(null);
      }
    },
    [exportProgress, experimentGetFile, state.clips],
  );

  const exportCurrentRun = useCallback(() => {
    const exp = director.getExperiment();
    if (exp && director.state.storyboard) {
      void runDebugExport(exp, director.state.storyboard);
    }
  }, [director, runDebugExport]);

  /** Enhance every selected clip, one at a time (per-clip progress shows in each row). */
  const enhanceSelected = useCallback(async () => {
    const ids = selectedClips.map((c) => c.clipId);
    if (ids.length === 0) return;
    setBulkRunning(true);
    try {
      for (const clipId of ids) {
        await enhanceClip(clipId, cloudScope, cloudModel);
      }
    } finally {
      setBulkRunning(false);
    }
  }, [selectedClips, enhanceClip, cloudScope, cloudModel]);

  const searchReady =
    state.models.embed.state === "ready" &&
    state.clips.some((c) => c.status === "done");

  /** Archived caption models across loaded clips, per scope (for mixer pins). */
  const captionModelOptions = useMemo(() => {
    const shots = new Set<string>();
    const timeline = new Set<string>();
    for (const c of state.clips) {
      for (const e of c.dossier?.cloudRunArchive ?? []) {
        (e.scope === "shots" ? shots : timeline).add(e.model);
      }
    }
    return { shots: [...shots].sort(), timeline: [...timeline].sort() };
  }, [state.clips]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Perception Lab</h1>
            <p className="text-sm text-text-secondary">
              Stage ② spike — drop clips, watch them get understood. 100% local:
              shots, motion, SigLIP2 embeddings, FastVLM captions & Whisper run
              in your browser.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer select-none text-text-secondary">
              <input
                type="checkbox"
                checked={cloudEnabled}
                onChange={(e) => setCloudEnabled(e.target.checked)}
              />
              <span>
                Cloud vision{" "}
                <span className="text-text-secondary/70">
                  — sampled frames leave this device (OpenAI)
                </span>
              </span>
            </label>
            {cloudEnabled && (
              <select
                className="bg-background-secondary border border-border rounded px-1.5 py-0.5 text-text-primary"
                value={cloudScope}
                onChange={(e) => setCloudScope(e.target.value as CloudScope)}
                title="How much to send per enhance: one frame per shot, or the full sampled timeline"
              >
                <option value="shots">shots only</option>
                <option value="timeline">full timeline</option>
              </select>
            )}
            {cloudEnabled && (
              <select
                className="bg-background-secondary border border-border rounded px-1.5 py-0.5 text-text-primary"
                value={cloudModel}
                onChange={(e) => setCloudModel(e.target.value as CaptionModel)}
                title="Caption model: 5.2 = flagship; 5.4-mini ~3x cheaper; 5.4-nano ~11x cheaper. Runs per model coexist for comparison."
              >
                {CAPTION_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m.replace("gpt-", "")}
                  </option>
                ))}
              </select>
            )}
            {cloudEnabled && state.clips.some((c) => c.status === "done") && (
              <>
                <span className="inline-flex rounded border border-border overflow-hidden">
                  <button
                    className="px-1.5 py-0.5 text-text-secondary hover:bg-background"
                    onClick={() => setAllSelected(true)}
                    title="Select every analyzed clip"
                  >
                    all
                  </button>
                  <button
                    className="px-1.5 py-0.5 text-text-secondary hover:bg-background border-l border-border"
                    onClick={() => setAllSelected(false)}
                    title="Clear the selection, then hand-pick clips"
                  >
                    none
                  </button>
                </span>
                <button
                  className="px-2 py-0.5 rounded border border-sky-500/50 text-sky-600 hover:bg-sky-500/10 disabled:opacity-40 disabled:cursor-default"
                  disabled={bulkRunning || selectedClips.length === 0}
                  onClick={() => void enhanceSelected()}
                  title="Send the checked clips' frames to the cloud vision model, one clip at a time"
                >
                  {bulkRunning
                    ? "enhancing…"
                    : `enhance ${selectedClips.length} selected`}
                </button>
              </>
            )}
          </div>
        </header>

        {state.clips.length === 0 ? (
          <div className="space-y-4">
            <ClipDropZone onFiles={addFiles} />
            <div className="max-w-md">
              <ExperimentsPanel
                refreshToken={experimentsRefresh}
                onOpen={setExperimentOpen}
                onCompareGrid={() => setMatrixOpen(true)}
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-3">
              {state.clips.map((clip) => (
                <ShotFilmstrip
                  key={clip.clipId}
                  clip={clip}
                  highlights={highlightsByClip.get(clip.clipId) ?? new Map()}
                  onShotClick={(shot) => openPreview(clip.clipId, clip.fileName, shot)}
                  onEnhance={
                    cloudEnabled ? () => void enhanceClip(clip.clipId, cloudScope, cloudModel) : null
                  }
                  onCompare={() => setCompareClip(clip)}
                  selected={cloudEnabled ? isSelected(clip) : null}
                  onSelectChange={(checked) =>
                    setSelectedOverride((m) => ({ ...m, [clip.clipId]: checked }))
                  }
                />
              ))}
              <ClipDropZone onFiles={addFiles} compact />
            </div>

            <div className="space-y-3">
              <DirectorPanel
                director={director}
                ready={searchReady}
                clipsDone={state.clips.filter((c) => c.status === "done").length}
                clipsTotal={state.clips.length}
                captionModelOptions={captionModelOptions}
              />
              {director.state.storyboard && (
                <StoryboardList
                  storyboard={director.state.storyboard}
                  warnings={director.state.warnings}
                  targetDurationS={director.state.targetDurationS}
                  onRemove={director.removeItem}
                  onMove={director.moveItem}
                  onPlay={setStoryboardStart}
                  onExportDebug={exportProgress === null ? exportCurrentRun : null}
                  exportProgress={exportProgress}
                />
              )}
              <SearchPanel
                hits={state.search.hits}
                searching={state.search.searching}
                ready={searchReady}
                onSearch={runSearch}
                onHitClick={handleHitClick}
              />
              <SceneTimelinePanel
                clips={state.clips}
                onCaptionClick={handleCaptionClick}
                onCompare={setCompareClip}
              />
              <TranscriptPanel clips={state.clips} onSegmentClick={handleSegmentClick} />
              <PerfPanel clips={state.clips} models={state.models} />
              <ExperimentsPanel
                refreshToken={experimentsRefresh}
                onOpen={setExperimentOpen}
                onCompareGrid={() => setMatrixOpen(true)}
              />
            </div>
          </div>
        )}
      </div>
      {preview && <ShotPreviewModal preview={preview} onClose={() => setPreview(null)} />}
      {compareClip && (
        <CaptionCompareModal
          clip={compareClip}
          onClose={() => setCompareClip(null)}
          onJumpTo={(t) => {
            setCompareClip(null);
            openPreviewAt(compareClip, t);
          }}
        />
      )}
      {experimentOpen && (
        <ExperimentDetailModal
          experimentId={experimentOpen}
          missingFiles={experimentMissingFiles}
          exportProgress={exportProgress}
          onWatch={(exp) => {
            if (exp.storyboard) {
              setReplay({ storyboard: exp.storyboard, getFile: experimentGetFile(exp) });
            }
          }}
          onExportDebug={(exp) => {
            if (exp.storyboard) void runDebugExport(exp, exp.storyboard);
          }}
          onDeleted={() => {
            setExperimentOpen(null);
            setExperimentsRefresh((n) => n + 1);
          }}
          onClose={() => setExperimentOpen(null)}
        />
      )}
      {matrixOpen && (
        <ExperimentMatrixModal
          resolveGetFile={experimentGetFile}
          missingFiles={experimentMissingFiles}
          onClose={() => setMatrixOpen(false)}
        />
      )}
      {replay && (
        <StoryboardPreviewModal
          storyboard={replay.storyboard}
          getFile={replay.getFile}
          initialIndex={0}
          onClose={() => setReplay(null)}
        />
      )}
      {storyboardStart !== null && director.state.storyboard && (
        <StoryboardPreviewModal
          storyboard={director.state.storyboard}
          getFile={getFile}
          initialIndex={storyboardStart}
          onClose={() => setStoryboardStart(null)}
        />
      )}
    </div>
  );
}
