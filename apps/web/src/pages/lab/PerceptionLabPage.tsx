import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CandidatePick,
  CloudScope,
  DenseCaption,
  SearchHit,
  Shot,
  Storyboard,
  TranscriptSegment,
} from "@openreel/core";
import { buildFootageDigest, stylePresetById } from "@openreel/core";
import { suggestBriefs, type BriefSuggestion } from "../../services/brief-suggestions";
import { compileStoryboardToProject } from "../../services/compile-storyboard";
import { CAPTION_MODELS, type CaptionModel } from "../../services/cloud-vision";
import { downloadBlob, exportDebugVideo, type DebugExportMeta } from "../../services/debug-export";
import {
  saveExperiment,
  saveExperimentVideo,
  type DirectorExperiment,
} from "../../services/experiments";
import { proxiedMusicUrl } from "../../services/suno";
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
import { SignalsPanel } from "./components/SignalsPanel";
import { ShotPreviewModal, type ShotPreview } from "./components/ShotPreviewModal";
import { StoryboardList } from "./components/StoryboardList";
import { StoryboardPreviewModal } from "./components/StoryboardPreviewModal";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { useDirector } from "./use-director";
import { useMusic } from "./use-music";
import { usePerceptionLab, type LabClip } from "./use-perception-lab";

/**
 * Debug-export music meta from the experiment's COMMITTED track only — an
 * A/B'd-but-unpicked session (or no music at all) omits `music` entirely
 * rather than guessing which take to bake in.
 */
function committedMusicMeta(exp: DirectorExperiment): DebugExportMeta["music"] {
  const m = exp.music;
  if (!m?.committedTrackId) return undefined;
  const track = m.tracks.find((t) => t.id === m.committedTrackId);
  if (!track) return undefined;
  return {
    title: track.title,
    modelName: track.modelName,
    durationS: track.durationS,
    trackIndex: m.tracks.findIndex((t) => t.id === track.id) + 1,
    trackCount: m.tracks.length,
    audioUrl: proxiedMusicUrl(track.audioUrl || track.streamAudioUrl) || null,
  };
}

/**
 * Clips enhanced concurrently in a bulk run. Each clip already runs 5
 * concurrent batches internally, so 3 clips = up to 15 in-flight requests —
 * fine for the proxy, and each batch still has its own retry.
 */
const BULK_CLIP_CONCURRENCY = 3;

/** Format seconds as "Xh YYm" (≥1h), "YYm", or "<1m". */
function formatDurationCompact(seconds: number): string {
  if (seconds < 1) return "<1m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export function PerceptionLabPage() {
  const { params, navigate } = useRouter();
  const forceDevice = params.device === "wasm" ? "wasm" : "auto";
  const { state, addFiles, runSearch, getFile, getDossiers, embedQuery, enhanceClip, selection } =
    usePerceptionLab(forceDevice);
  const director = useDirector({ getDossiers, embedQuery });
  const music = useMusic();
  // Contextual background-music toggle; lives here (not in DirectorPanel) so
  // it survives across Direct/refine cycles like cloudEnabled does below.
  const [musicEnabled, setMusicEnabled] = useState(false);
  // Locked style preset (or null = unlocked) — lifted here so the director
  // brief, the ✨ suggestions, and the music brief all share one selection.
  const [styleId, setStyleId] = useState<string | null>(null);
  // Which experiment a music generation has already been kicked off for —
  // refine() reuses the SAME experimentId, so this guards against
  // regenerating on every refine round (only a genuinely new Direct run
  // gets a new id).
  const musicGeneratedForRef = useRef<string | null>(null);
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
  /**
   * Compile-to-editor status line: live progress while a compile runs, or
   * the blocking error (missing files / import failure) after one fails —
   * cleared on the next attempt. `compiling` gates the button separately so
   * a lingering error line doesn't keep it disabled.
   */
  const [compileProgress, setCompileProgress] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  /**
   * Replay of a stored experiment's cut (storyboard + remapped files). Carries
   * the experiment so its generated music tracks stay A/B-able and committable
   * after a refresh, when the live director/music session is gone.
   */
  const [replay, setReplay] = useState<{
    storyboard: Storyboard;
    getFile: (clipId: string) => File | null;
    exp: DirectorExperiment | null;
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
  /**
   * Candidates-only cloud enhance: restrict frame plans to the selector's
   * candidate shots. Default (no override) is checked as soon as candidates
   * exist — the whole point of the selector is to stop sending everything.
   */
  const [candidatesOnlyOverride, setCandidatesOnlyOverride] = useState<boolean | null>(null);

  const isSelected = useCallback(
    (clip: LabClip) => selectedOverride[clip.clipId] ?? !clip.dossier?.cloudRuns?.[cloudScope],
    [selectedOverride, cloudScope],
  );

  const selectedClips = state.clips.filter(
    (c) => c.status === "done" && !c.cloud?.busy && isSelected(c),
  );

  // clipId -> (shotIndex -> pick) for filmstrip badges, the Signals panel,
  // and candidates-only enhance scoping.
  const picksByClip = useMemo(() => {
    const map = new Map<string, Map<number, CandidatePick>>();
    if (!selection) return map;
    for (const pick of selection.picks) {
      let clipMap = map.get(pick.clipId);
      if (!clipMap) {
        clipMap = new Map();
        map.set(pick.clipId, clipMap);
      }
      clipMap.set(pick.shotIndex, pick);
    }
    return map;
  }, [selection]);

  const selectionSummary = useMemo(
    () =>
      selection
        ? {
            picks: selection.picks.length,
            chapters: selection.chapters.length,
            totalShots: selection.scores.length,
          }
        : null,
    [selection],
  );

  const hasCandidates = (selectionSummary?.picks ?? 0) > 0;
  const candidatesOnly = candidatesOnlyOverride ?? hasCandidates;

  // Bulk enhance excludes clips with zero candidate shots when scoped to
  // candidates-only — sending nothing costs nothing, so they're dropped
  // before the count/label, not sent with an empty frame plan.
  const candidateFilteredClips = candidatesOnly
    ? selectedClips.filter((c) => (picksByClip.get(c.clipId)?.size ?? 0) > 0)
    : selectedClips;
  const skippedForNoCandidates = candidatesOnly
    ? selectedClips.length - candidateFilteredClips.length
    : 0;

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

  /** (Re)kick off a background-music generation for the current storyboard. */
  const runMusicGenerate = useCallback(() => {
    const storyboard = director.state.storyboard;
    if (!storyboard) return;
    const exp = director.getExperiment();
    const sceneHints = storyboard.items
      .slice(0, 5)
      .map((i) => i.why)
      .filter((w): w is string => Boolean(w));
    music.generate(
      exp?.brief ?? "",
      storyboard,
      director.state.targetDurationS,
      sceneHints,
      stylePresetById(exp?.styleId ?? styleId)?.musicHint ?? null,
    );
  }, [director, music, styleId]);

  // Auto-generate the music bed once per director conversation (not per
  // refine round — refine reuses the same experimentId, see
  // musicGeneratedForRef) when the toggle is on and a storyboard lands.
  useEffect(() => {
    if (!musicEnabled) return;
    if (director.state.phase !== "awaiting-refine" || !director.state.storyboard) return;
    const expId = director.state.experimentId;
    if (!expId || musicGeneratedForRef.current === expId) return;
    musicGeneratedForRef.current = expId;
    runMusicGenerate();
  }, [musicEnabled, director.state.phase, director.state.experimentId, runMusicGenerate]);

  // Persist the music session onto the SAME experiment object the director
  // hook holds (get/save, mirroring use-director's own persistExperiment) so
  // both a current-run debug export and the stored record see it.
  useEffect(() => {
    if (music.state.tracks.length === 0 && music.state.committedTrackId === null) return;
    if (!music.state.brief || !music.state.taskId) return;
    const exp = director.getExperiment();
    if (!exp) return;
    exp.music = {
      brief: music.state.brief,
      taskId: music.state.taskId,
      tracks: music.state.tracks,
      committedTrackId: music.state.committedTrackId,
    };
    exp.updatedAt = Date.now();
    void saveExperiment(exp).catch(() => undefined);
  }, [
    music.state.tracks,
    music.state.committedTrackId,
    music.state.brief,
    music.state.taskId,
    director,
  ]);

  /** Commit a track from a stored-experiment replay (persists to the record). */
  const commitReplayTrack = useCallback((trackId: string) => {
    setReplay((r) => {
      if (!r?.exp?.music) return r;
      const exp = {
        ...r.exp,
        updatedAt: Date.now(),
        music: { ...r.exp.music, committedTrackId: trackId },
      };
      void saveExperiment(exp).catch(() => undefined);
      setExperimentsRefresh((n) => n + 1);
      return { ...r, exp };
    });
  }, []);

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
            music: committedMusicMeta(exp),
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

  /** Compile a storyboard into a real project and jump to #/editor (shared by
   * the live run and stored experiments — only the file resolver and music
   * record differ). */
  const runCompileStoryboard = useCallback(
    async (
      storyboard: Storyboard,
      resolveFile: (clipId: string) => File | null,
      musicRecord: DirectorExperiment["music"] | undefined,
    ) => {
      if (compiling || exportProgress !== null) return;
      setCompiling(true);
      setCompileProgress("starting…");
      try {
        // Committed music only — an A/B'd-but-unpicked session compiles dry.
        const track = musicRecord?.committedTrackId
          ? musicRecord.tracks.find((t) => t.id === musicRecord.committedTrackId)
          : undefined;
        const audioUrl = track ? proxiedMusicUrl(track.audioUrl || track.streamAudioUrl) : "";
        const result = await compileStoryboardToProject({
          storyboard,
          getFile: resolveFile,
          music: track && audioUrl ? { audioUrl, durationS: track.durationS } : null,
          onProgress: setCompileProgress,
        });
        if (result.ok) {
          // Keep a music-skipped warning visible (shows if the user returns here).
          setCompileProgress(result.warning ?? null);
          navigate("editor");
        } else if (result.missing.length > 0) {
          setCompileProgress(
            `missing ${result.missing.length} file(s), re-drop: ${result.missing.join(", ")}`,
          );
        } else {
          setCompileProgress(result.error ?? "compile failed");
        }
      } catch (err) {
        console.error("[compile-storyboard]", err);
        setCompileProgress(err instanceof Error ? err.message : String(err));
      } finally {
        setCompiling(false);
      }
    },
    [compiling, exportProgress, navigate],
  );

  /** Compile the current storyboard into a real project and jump to #/editor. */
  const compileCurrentRun = useCallback(() => {
    const storyboard = director.state.storyboard;
    if (!storyboard) return;
    return runCompileStoryboard(storyboard, getFile, director.getExperiment()?.music);
  }, [director, getFile, runCompileStoryboard]);

  /** Compile a STORED experiment's cut (old clip ids remapped via cacheKey). */
  const runCompile = useCallback(
    (exp: DirectorExperiment) => {
      if (!exp.storyboard) return;
      return runCompileStoryboard(exp.storyboard, experimentGetFile(exp), exp.music);
    },
    [experimentGetFile, runCompileStoryboard],
  );

  /**
   * Enhance every selected clip, a few at a time (per-clip progress shows in
   * each row). Small clips are tail-latency bound, so overlapping them cuts
   * bulk wall-clock ~2-3x at identical token cost.
   */
  const enhanceSelected = useCallback(async () => {
    const ids = candidateFilteredClips.map((c) => c.clipId);
    if (ids.length === 0) return;
    setBulkRunning(true);
    try {
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const clipId = ids[next];
          next += 1;
          const candidateShotIndexes = candidatesOnly
            ? new Set(picksByClip.get(clipId)?.keys() ?? [])
            : undefined;
          await enhanceClip(
            clipId,
            cloudScope,
            cloudModel,
            candidateShotIndexes ? { candidateShotIndexes } : undefined,
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(BULK_CLIP_CONCURRENCY, ids.length) }, () => worker()),
      );
    } finally {
      setBulkRunning(false);
    }
  }, [candidateFilteredClips, enhanceClip, cloudScope, cloudModel, candidatesOnly, picksByClip]);

  /** Digest the analyzed footage and ask for grounded brief-angle suggestions. */
  const requestBriefSuggestions = useCallback(
    async (targetS: number | null): Promise<BriefSuggestion[]> => {
      const dossiers = getDossiers();
      if (dossiers.length === 0) {
        throw new Error("No analyzed clips yet — drop footage first.");
      }
      const digest = buildFootageDigest(dossiers);
      return suggestBriefs(digest, targetS, stylePresetById(styleId));
    },
    [getDossiers, styleId],
  );

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

  const loadedS = state.clips.reduce((sum, c) => sum + (c.analyzedThroughS ?? c.durationS), 0);
  const fullS = state.clips.reduce((sum, c) => sum + c.durationS, 0);

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
            {state.clips.length > 0 && (
              <p className="text-sm text-text-secondary mt-2">
                {state.clips.length} clip{state.clips.length === 1 ? "" : "s"} ·{" "}
                {formatDurationCompact(loadedS)} loaded
                {fullS - loadedS > 60 ? ` (of ${formatDurationCompact(fullS)})` : ""}
              </p>
            )}
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
            {cloudEnabled && hasCandidates && (
              <label
                className="flex items-center gap-1 cursor-pointer select-none text-amber-500"
                title="Restrict cloud enhance to the signal-stack selector's candidate shots — cheaper, focused on what the director will actually see highlighted"
              >
                <input
                  type="checkbox"
                  checked={candidatesOnly}
                  onChange={(e) => setCandidatesOnlyOverride(e.target.checked)}
                />
                ★ candidates only
              </label>
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
                  disabled={bulkRunning || candidateFilteredClips.length === 0}
                  onClick={() => void enhanceSelected()}
                  title={
                    skippedForNoCandidates > 0
                      ? `Send the checked clips' candidate frames to the cloud vision model (skipping ${skippedForNoCandidates} clip${skippedForNoCandidates === 1 ? "" : "s"} with no candidate shots)`
                      : "Send the checked clips' frames to the cloud vision model, one clip at a time"
                  }
                >
                  {bulkRunning
                    ? "enhancing…"
                    : `enhance ${candidateFilteredClips.length} selected`}
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
              {state.clips.map((clip) => {
                const clipPicks = picksByClip.get(clip.clipId);
                const noCandidatesForClip =
                  candidatesOnly && clip.status === "done" && (clipPicks?.size ?? 0) === 0;
                return (
                  <ShotFilmstrip
                    key={clip.clipId}
                    clip={clip}
                    highlights={highlightsByClip.get(clip.clipId) ?? new Map()}
                    picks={clipPicks}
                    onShotClick={(shot) => openPreview(clip.clipId, clip.fileName, shot)}
                    onEnhance={
                      cloudEnabled
                        ? () =>
                            void enhanceClip(
                              clip.clipId,
                              cloudScope,
                              cloudModel,
                              candidatesOnly && clipPicks
                                ? { candidateShotIndexes: new Set(clipPicks.keys()) }
                                : undefined,
                            )
                        : null
                    }
                    enhanceDisabledReason={
                      noCandidatesForClip ? "no candidate shots in this clip" : null
                    }
                    onCompare={() => setCompareClip(clip)}
                    selected={cloudEnabled ? isSelected(clip) : null}
                    onSelectChange={(checked) =>
                      setSelectedOverride((m) => ({ ...m, [clip.clipId]: checked }))
                    }
                  />
                );
              })}
              <ClipDropZone onFiles={addFiles} compact />
            </div>

            <div className="space-y-3">
              <DirectorPanel
                director={director}
                ready={searchReady}
                clipsDone={state.clips.filter((c) => c.status === "done").length}
                clipsTotal={state.clips.length}
                captionModelOptions={captionModelOptions}
                musicEnabled={musicEnabled}
                onMusicEnabledChange={setMusicEnabled}
                musicState={music.state}
                onMusicRetry={runMusicGenerate}
                requestBriefSuggestions={requestBriefSuggestions}
                styleId={styleId}
                onStyleIdChange={setStyleId}
                selectionSummary={selectionSummary}
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
                  onCompile={
                    !compiling &&
                    exportProgress === null &&
                    director.state.storyboard.items.length > 0
                      ? () => void compileCurrentRun()
                      : null
                  }
                  compileProgress={compileProgress}
                />
              )}
              <SearchPanel
                hits={state.search.hits}
                searching={state.search.searching}
                ready={searchReady}
                onSearch={runSearch}
                onHitClick={handleHitClick}
              />
              <SignalsPanel
                clips={state.clips}
                selection={selection}
                onShotClick={(clip, shot) => openPreview(clip.clipId, clip.fileName, shot)}
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
              setReplay({ storyboard: exp.storyboard, getFile: experimentGetFile(exp), exp });
            }
          }}
          onExportDebug={(exp) => {
            if (exp.storyboard) void runDebugExport(exp, exp.storyboard);
          }}
          onCompile={(exp) => void runCompile(exp)}
          compiling={compiling}
          compileProgress={compileProgress}
          onChanged={() => setExperimentsRefresh((n) => n + 1)}
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
          music={
            replay.exp?.music && replay.exp.music.tracks.length > 0
              ? {
                  tracks: replay.exp.music.tracks,
                  committedTrackId: replay.exp.music.committedTrackId,
                  onCommit: commitReplayTrack,
                }
              : undefined
          }
        />
      )}
      {storyboardStart !== null && director.state.storyboard && (
        <StoryboardPreviewModal
          storyboard={director.state.storyboard}
          getFile={getFile}
          initialIndex={storyboardStart}
          onClose={() => setStoryboardStart(null)}
          music={
            music.state.phase !== "off"
              ? {
                  tracks: music.state.tracks,
                  committedTrackId: music.state.committedTrackId,
                  onCommit: music.commit,
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
