/**
 * The screening-room player: plays the cut from the ORIGINAL files in
 * sequence with a single <video>, exactly StoryboardPreviewModal's proven
 * pattern (pages/lab/components/StoryboardPreviewModal.tsx) — seek to
 * `inS`, advance at `outS` via requestVideoFrameCallback (falling back to
 * timeupdate where rVFC is unavailable) — reimplemented against the public
 * PublicCutSegment vocabulary instead of a core Storyboard (see
 * player-advance.ts's file header for why this isn't a straight import).
 *
 * `index`/`started` are CONTROLLED from ScreeningRoomScene so the segment
 * strip can jump the playhead (docs/wizz-ui-draft.html: "click = jump
 * playhead").
 */
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import type { PublicCutSegment } from "../../publicflow/types";
import { fmtClockHHMMSS } from "../format";
import { cutRelativeRanges, nextSegmentIndex, pastSegmentEnd } from "../player-advance";

const HAS_RVFC =
  typeof HTMLVideoElement !== "undefined" &&
  typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function";

export interface PlayerProps {
  segments: PublicCutSegment[];
  index: number;
  onIndexChange: (index: number) => void;
  started: boolean;
  onStart: () => void;
  getFile: (clipId: string) => File | null;
}

export function Player({ segments, index, onIndexChange, started, onStart, getFile }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [done, setDone] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);
  const advancedFromRef = useRef(-1);

  const ranges = useMemo(() => cutRelativeRanges(segments), [segments]);
  const totalS = ranges.length > 0 ? ranges[ranges.length - 1].endS : 0;

  const item = segments[index] as PublicCutSegment | undefined;
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

  // Seek to the new segment's start whenever it (or the source) changes.
  useEffect(() => {
    setDone(false);
    const v = videoRef.current;
    if (!v || !url || !item || !started) return;
    if (v.readyState >= 1) {
      v.currentTime = item.inS;
      v.play().catch(() => {});
    }
  }, [index, url, item, started]);

  const crossBoundary = useCallback(
    (v: HTMLVideoElement, presentedTimeS: number): boolean => {
      if (!item) return false;
      if (!pastSegmentEnd(presentedTimeS, item.outS) || advancedFromRef.current === index) {
        return false;
      }
      advancedFromRef.current = index;
      const next = nextSegmentIndex(index, segments.length);
      if (next !== null) {
        onIndexChange(next);
      } else {
        v.pause();
        setDone(true);
      }
      return true;
    },
    [index, item, segments.length, onIndexChange],
  );

  const updateElapsed = useCallback(
    (segmentTimeS: number) => {
      const base = ranges[index]?.startS ?? 0;
      const within = item ? Math.max(0, segmentTimeS - item.inS) : 0;
      setElapsedS(Math.min(totalS, base + within));
    },
    [ranges, index, item, totalS],
  );

  // Frame-accurate boundary watcher (Chrome/Safari); the timeupdate handler
  // below covers browsers without rVFC.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url || !HAS_RVFC) return;
    let handle: number | null = null;
    const cancel = () => {
      if (handle !== null) {
        v.cancelVideoFrameCallback(handle);
        handle = null;
      }
    };
    const tick = (_now: number, meta: { mediaTime: number }) => {
      handle = null;
      if (!v.seeking) {
        updateElapsed(meta.mediaTime);
        if (crossBoundary(v, meta.mediaTime)) return;
      }
      if (!v.paused && !v.ended) handle = v.requestVideoFrameCallback(tick);
    };
    const arm = () => {
      if (handle === null) handle = v.requestVideoFrameCallback(tick);
    };
    v.addEventListener("play", arm);
    v.addEventListener("seeked", arm);
    v.addEventListener("pause", cancel);
    if (!v.paused) arm();
    return () => {
      cancel();
      v.removeEventListener("play", arm);
      v.removeEventListener("seeked", arm);
      v.removeEventListener("pause", cancel);
    };
  }, [url, crossBoundary, updateElapsed]);

  const onTimeUpdateFallback = HAS_RVFC
    ? undefined
    : (e: SyntheticEvent<HTMLVideoElement>) => {
        const v = e.currentTarget;
        updateElapsed(v.currentTime);
        crossBoundary(v, v.currentTime);
      };

  const play = () => {
    advancedFromRef.current = -1;
    setDone(false);
    onStart();
  };

  return (
    <div className="player">
      {!started && !done && (
        <button className="play" aria-label="Play" onClick={play}>
          ▶
        </button>
      )}
      {done && (
        <button
          className="play"
          aria-label="Replay"
          onClick={() => {
            onIndexChange(0);
            play();
          }}
        >
          ↺
        </button>
      )}
      {url && started && (
        <video
          ref={videoRef}
          src={url}
          playsInline
          onLoadedMetadata={(e) => {
            if (item) e.currentTarget.currentTime = item.inS;
            e.currentTarget.play().catch(() => {});
          }}
          onTimeUpdate={onTimeUpdateFallback}
        />
      )}
      <div className="osd tc">
        <span>{fmtClockHHMMSS(elapsedS)}</span>
        <span>{fmtClockHHMMSS(totalS)}</span>
      </div>
    </div>
  );
}
