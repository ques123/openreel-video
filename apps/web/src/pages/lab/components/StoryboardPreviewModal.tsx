import { useCallback, useEffect, useRef, useState } from "react";
import { MUSIC_BED_VOLUME, type Storyboard } from "@openreel/core";
import { proxiedMusicUrl, type SunoTrack } from "../../../services/suno";
import { nextSegmentIndex, pastSegmentEnd } from "./segment-boundary";

interface StoryboardPreviewModalProps {
  storyboard: Storyboard;
  getFile: (clipId: string) => File | null;
  /** Segment to start playback from (clicking a storyboard row jumps here). */
  initialIndex?: number;
  onClose: () => void;
  /**
   * A/B the generated background-music tracks while previewing the cut. The
   * bed does NOT seek-sync to segments — it's a loop that just follows the
   * video's play/pause/ended transport.
   */
  music?: {
    tracks: SunoTrack[];
    committedTrackId: string | null;
    onCommit: (id: string) => void;
  };
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

/**
 * requestVideoFrameCallback support (Chrome 83+/Safari 15.4+; the odd browser
 * without it and jsdom keep the timeupdate fallback). Prototype-checked once
 * so the render path can pick the fallback handler statically.
 */
const HAS_RVFC =
  typeof HTMLVideoElement !== "undefined" &&
  typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function";

/**
 * Plays the storyboard's segments in order from the ORIGINAL files with a
 * single <video>. Segment boundaries are enforced per PRESENTED frame via
 * requestVideoFrameCallback (Chrome/Safari), so cuts land within a frame of
 * the out-point — close to the frame-exact export, which refine decisions on
 * sub-second segments are judged against. Where rVFC is unavailable the old
 * timeupdate fallback (~250ms granularity; segments may run a hair long)
 * still applies. Segment starts assign `currentTime`, which modern engines
 * treat as a PRECISE seek (decode from the previous keyframe up to the exact
 * time); `fastSeek()` would start playback sooner but lands on keyframes —
 * the wrong trade when auditioning cut points.
 */
export function StoryboardPreviewModal({
  storyboard,
  getFile,
  initialIndex = 0,
  onClose,
  music,
}: StoryboardPreviewModalProps) {
  const items = storyboard.items;
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(initialIndex, 0), items.length - 1),
  );
  const [done, setDone] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  // Guard so a burst of boundary checks (presented frames or timeupdates)
  // past the out-point advances only once.
  const advancedFromRef = useRef(-1);

  const musicTracks = music?.tracks ?? [];
  const hasMusicBar = musicTracks.length > 0;
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(
    () => music?.committedTrackId ?? musicTracks[0]?.id ?? null,
  );
  const [muted, setMuted] = useState(false);

  // Keep the selection valid as tracks arrive (A/B set can grow 0 -> 1 -> 2);
  // default is the committed pick, else whatever landed first.
  useEffect(() => {
    if (!music) return;
    if (selectedTrackId && musicTracks.some((t) => t.id === selectedTrackId)) return;
    setSelectedTrackId(music.committedTrackId ?? musicTracks[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicTracks.map((t) => t.id).join(","), music?.committedTrackId]);

  const selectedTrack = musicTracks.find((t) => t.id === selectedTrackId) ?? null;

  // Swap the bed's source when the selection changes; if it was already
  // playing, keep it playing (this is a bed swap, not a seek).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !selectedTrack) return;
    const wasPlaying = !audio.paused;
    audio.volume = MUSIC_BED_VOLUME;
    audio.src = proxiedMusicUrl(selectedTrack.audioUrl || selectedTrack.streamAudioUrl);
    audio.load();
    if (wasPlaying) audio.play().catch(() => {});
  }, [selectedTrack?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.muted = muted;
  }, [muted]);

  const item = items[index];
  const file = item ? getFile(item.clipId) : null;

  // Create AND revoke the object URL inside one effect (StrictMode-safe; see
  // ShotPreviewModal). Consecutive segments from the same clip keep the URL
  // because the File reference is stable.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    setPlaybackError(null);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [file]);

  // Mirror the bed's transport to the video's — it's a loop, not synced to
  // segment boundaries, so play/pause/ended is all it needs. MUST re-run per
  // `url`: the <video> mounts only after the object URL resolves and is
  // replaced on cross-file segment swaps, so listeners wired earlier (or to
  // a null ref) die with the old element (same gotcha as the matrix modal).
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;
    const play = () => audio.play().catch(() => {});
    const pause = () => audio.pause();
    video.addEventListener("play", play);
    video.addEventListener("pause", pause);
    video.addEventListener("ended", pause);
    // The new segment's video may already be playing (autoPlay fired before
    // this effect) — catch the bed up instead of waiting for the next event.
    if (!video.paused) play();
    else pause();
    return () => {
      video.removeEventListener("play", play);
      video.removeEventListener("pause", pause);
      video.removeEventListener("ended", pause);
    };
  }, [hasMusicBar, url]);

  // Seek to the segment start whenever the segment (or source) changes. When
  // the src just swapped, metadata isn't loaded yet — onLoadedMetadata below
  // covers that path.
  useEffect(() => {
    setDone(false);
    const v = videoRef.current;
    if (!v || !url || !item) return;
    if (v.readyState >= 1) {
      v.currentTime = item.inS;
      v.play().catch(() => {});
    }
  }, [index, url, item]);

  /**
   * Advance (or finish) once the presented time reaches the segment's
   * out-point. Shared by the per-frame rVFC watcher and the timeupdate
   * fallback; `advancedFromRef` keeps a burst of checks past the boundary
   * from advancing more than once. Returns true when it advanced/finished.
   */
  const crossBoundary = useCallback(
    (v: HTMLVideoElement, presentedTimeS: number): boolean => {
      if (!item) return false;
      if (!pastSegmentEnd(presentedTimeS, item.outS) || advancedFromRef.current === index) {
        return false;
      }
      advancedFromRef.current = index;
      const next = nextSegmentIndex(index, items.length);
      if (next !== null) {
        setIndex(next);
      } else {
        v.pause();
        setDone(true);
      }
      return true;
    },
    [index, item, items.length],
  );

  // Frame-accurate boundary watcher: rVFC fires per PRESENTED frame (vs
  // timeupdate's ~250ms), so a cut is caught within one frame of the
  // out-point instead of up to ~0.3s late. Re-armed per segment/source; the
  // callback is cancelled on pause, segment change, and unmount, and
  // re-registered on play — plus on seeked, because a seek presents a frame
  // even while paused (scrubbing past the end while paused must still
  // advance, matching the old timeupdate behavior).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;
    if (typeof v.requestVideoFrameCallback !== "function") return; // fallback handles it
    let handle: number | null = null;
    const cancel = () => {
      if (handle !== null) {
        v.cancelVideoFrameCallback(handle);
        handle = null;
      }
    };
    // Params typed structurally (not VideoFrameRequestCallback) so eslint's
    // no-undef doesn't trip on the DOM lib type name.
    const tick = (_now: number, meta: { mediaTime: number }) => {
      handle = null;
      // mediaTime is the presented frame's time — currentTime can run a
      // little ahead of what's actually on screen. Skip checks mid-seek so a
      // stale frame from before a segment swap can't trip the next boundary.
      if (!v.seeking && crossBoundary(v, meta.mediaTime)) return;
      if (!v.paused && !v.ended) handle = v.requestVideoFrameCallback(tick);
    };
    const arm = () => {
      if (handle === null) handle = v.requestVideoFrameCallback(tick);
    };
    v.addEventListener("play", arm);
    v.addEventListener("seeked", arm);
    v.addEventListener("pause", cancel);
    // autoPlay may have started before this effect ran — catch up.
    if (!v.paused) arm();
    return () => {
      cancel();
      v.removeEventListener("play", arm);
      v.removeEventListener("seeked", arm);
      v.removeEventListener("pause", cancel);
    };
  }, [url, crossBoundary]);

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

  if (!item) return null;

  const restart = () => {
    advancedFromRef.current = -1;
    setDone(false);
    if (index === 0) {
      const v = videoRef.current;
      if (v) {
        v.currentTime = item.inS;
        v.play().catch(() => {});
      }
    } else {
      setIndex(0);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-background-secondary border border-border rounded-xl overflow-hidden max-w-4xl w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              {storyboard.title ?? "Storyboard preview"}
            </p>
            <p className="text-xs text-text-secondary font-mono">
              segment {index + 1}/{items.length} · {item.role} · {item.fileName} ·{" "}
              {fmtTime(item.inS)}–{fmtTime(item.outS)}
              {done && " · done"}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              className="text-text-secondary hover:text-text-primary text-sm px-2 disabled:opacity-20"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
              aria-label="Previous segment"
            >
              ‹
            </button>
            <button
              className="text-text-secondary hover:text-text-primary text-sm px-2 disabled:opacity-20"
              disabled={index === items.length - 1}
              onClick={() => setIndex(index + 1)}
              aria-label="Next segment"
            >
              ›
            </button>
            {done && (
              <button
                className="text-text-secondary hover:text-text-primary text-sm px-2"
                onClick={restart}
              >
                replay
              </button>
            )}
            <button
              className="text-text-secondary hover:text-text-primary text-xl px-2"
              onClick={onClose}
              aria-label="Close preview"
            >
              ×
            </button>
          </div>
        </div>

        {!file && (
          <div className="px-4 py-6 text-sm text-text-secondary">
            Original file for {item.fileName} is no longer available (files are held in
            memory for the session). Re-drop the clip to preview.
          </div>
        )}
        {playbackError && (
          <div className="px-4 py-6 text-sm text-text-secondary">
            <p className="text-text-primary mb-1">Can't play this file in the browser.</p>
            <p>
              {playbackError} — the clip is likely HEVC/H.265, which needs hardware codec
              support (Chrome on macOS/Windows usually has it). The storyboard itself is
              unaffected; this only breaks preview playback.
            </p>
          </div>
        )}
        {url && (
          <video
            ref={videoRef}
            src={url}
            controls
            autoPlay
            playsInline
            className={`w-full max-h-[70vh] bg-black ${playbackError ? "hidden" : ""}`}
            onError={(e) =>
              setPlaybackError(e.currentTarget.error?.message || "format not supported")
            }
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = item.inS;
            }}
            onTimeUpdate={
              HAS_RVFC
                ? undefined
                : (e) => {
                    const v = e.currentTarget;
                    crossBoundary(v, v.currentTime);
                  }
            }
            onSeeked={() => {
              // Re-arm the boundary when the user scrubs back inside the segment.
              const v = videoRef.current;
              if (v && !pastSegmentEnd(v.currentTime, item.outS)) advancedFromRef.current = -1;
            }}
          />
        )}

        {hasMusicBar && music && (
          <div className="flex items-center gap-2 px-4 py-2 border-t border-border bg-background text-xs flex-wrap">
            <span className="text-text-secondary shrink-0">♪ bed:</span>
            {musicTracks.map((t, i) => {
              const isSelected = selectedTrackId === t.id;
              const isCommitted = music.committedTrackId === t.id;
              return (
                <div
                  key={t.id}
                  className={`flex items-center rounded-md border overflow-hidden ${
                    isSelected ? "border-primary" : "border-border"
                  }`}
                >
                  <button
                    onClick={() => setSelectedTrackId(t.id)}
                    className={`px-2 py-1 text-[11px] ${
                      isSelected
                        ? "bg-primary/10 text-text-primary"
                        : "text-text-secondary hover:text-text-primary"
                    }`}
                    title={t.title}
                  >
                    track {i + 1}
                  </button>
                  {isSelected && (
                    <button
                      onClick={() => music.onCommit(t.id)}
                      disabled={isCommitted}
                      className={`px-2 py-1 text-[11px] border-l ${
                        isCommitted
                          ? "border-primary/40 text-primary cursor-default"
                          : "border-border text-text-secondary hover:text-text-primary"
                      }`}
                      title="Bake this track into the debug render"
                    >
                      {isCommitted ? "✓" : "use in render"}
                    </button>
                  )}
                </div>
              );
            })}
            <button
              onClick={() => setMuted((m) => !m)}
              className={`px-2 py-1 rounded-md border text-[11px] shrink-0 ${
                muted
                  ? "border-amber-500/50 text-amber-500"
                  : "border-border text-text-secondary hover:text-text-primary"
              }`}
            >
              {muted ? "unmute" : "mute"}
            </button>
            <audio ref={audioRef} loop crossOrigin="anonymous" />
          </div>
        )}
      </div>
    </div>
  );
}
