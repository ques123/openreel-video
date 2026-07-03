import { useCallback, useMemo, useState } from "react";
import type { DenseCaption, SearchHit, Shot, TranscriptSegment } from "@openreel/core";
import { useRouter } from "../../hooks/use-router";
import { ClipDropZone } from "./components/ClipDropZone";
import { DirectorPanel } from "./components/DirectorPanel";
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
  const { state, addFiles, runSearch, getFile, getDossiers, embedQuery } =
    usePerceptionLab(forceDevice);
  const director = useDirector({ getDossiers, embedQuery });
  const [preview, setPreview] = useState<ShotPreview | null>(null);
  /** Segment index to start storyboard playback from; null = closed. */
  const [storyboardStart, setStoryboardStart] = useState<number | null>(null);

  const openPreview = useCallback(
    (clipId: string, fileName: string, shot: Shot) => {
      const file = getFile(clipId);
      if (file) setPreview({ file, fileName, shot });
    },
    [getFile],
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

  const handleCaptionClick = useCallback(
    (clip: LabClip, dc: DenseCaption) => {
      const file = getFile(clip.clipId);
      if (!file) return;
      // Containing shot, or nearest one (the final dense frame can sit exactly
      // on the last shot's end boundary).
      const shot =
        clip.shots.find((s) => dc.t >= s.tStart && dc.t < s.tEnd) ??
        clip.shots.reduce<Shot | null>(
          (best, s) =>
            !best ||
            Math.abs(dc.t - (s.tStart + s.tEnd) / 2) <
              Math.abs(dc.t - (best.tStart + best.tEnd) / 2)
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
        startAtS: dc.t,
        caption: dc.text,
      });
    },
    [getFile, scrollToShot],
  );

  const searchReady =
    state.models.clip.state === "ready" &&
    state.clips.some((c) => c.status === "done");

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-text-primary">Perception Lab</h1>
          <p className="text-sm text-text-secondary">
            Stage ② spike — drop clips, watch them get understood. 100% local:
            shots, motion, CLIP embeddings & Whisper run in your browser.
          </p>
        </header>

        {state.clips.length === 0 ? (
          <ClipDropZone onFiles={addFiles} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-3">
              {state.clips.map((clip) => (
                <ShotFilmstrip
                  key={clip.clipId}
                  clip={clip}
                  highlights={highlightsByClip.get(clip.clipId) ?? new Map()}
                  onShotClick={(shot) => openPreview(clip.clipId, clip.fileName, shot)}
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
              />
              {director.state.storyboard && (
                <StoryboardList
                  storyboard={director.state.storyboard}
                  warnings={director.state.warnings}
                  targetDurationS={director.state.targetDurationS}
                  onRemove={director.removeItem}
                  onMove={director.moveItem}
                  onPlay={setStoryboardStart}
                />
              )}
              <SearchPanel
                hits={state.search.hits}
                searching={state.search.searching}
                ready={searchReady}
                onSearch={runSearch}
                onHitClick={handleHitClick}
              />
              <SceneTimelinePanel clips={state.clips} onCaptionClick={handleCaptionClick} />
              <TranscriptPanel clips={state.clips} onSegmentClick={handleSegmentClick} />
              <PerfPanel clips={state.clips} models={state.models} />
            </div>
          </div>
        )}
      </div>
      {preview && <ShotPreviewModal preview={preview} onClose={() => setPreview(null)} />}
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
