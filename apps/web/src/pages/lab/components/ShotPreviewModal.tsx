import { useEffect, useRef, useState } from "react";
import type { DenseCaption, Shot } from "@openreel/core";
import { captionAt } from "../caption-views";

export interface ShotPreview {
  file: File;
  fileName: string;
  shot: Shot;
  /** Seek here instead of the shot start (e.g. a scene-timeline caption's frame). */
  startAtS?: number;
  /** Caption to show in the header instead of the shot's own. */
  caption?: string;
  /**
   * Full caption timelines for the clip. When present, the header caption
   * follows the playhead (subtitle-style) and a local/cloud switch appears
   * whenever a cloud timeline exists.
   */
  timelines?: { local: DenseCaption[]; cloud: DenseCaption[] };
}

interface ShotPreviewModalProps {
  preview: ShotPreview;
  onClose: () => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

/**
 * Plays the shot's time range from the ORIGINAL file (object URL — the
 * media pipeline range-reads the file; no blob machinery involved).
 * Pauses at the shot boundary; scrubbing anywhere is allowed.
 */
export function ShotPreviewModal({ preview, onClose }: ShotPreviewModalProps) {
  const { file, fileName, shot, timelines } = preview;
  const startAtS = preview.startAtS ?? shot.tStart;
  const hasCloud = (timelines?.cloud.length ?? 0) > 0;
  const hasLocal = (timelines?.local.length ?? 0) > 0;
  const [source, setSource] = useState<"local" | "cloud">(hasCloud ? "cloud" : "local");
  const [playheadT, setPlayheadT] = useState(startAtS);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [pastEnd, setPastEnd] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  // Create AND revoke the object URL inside one effect so each mount owns its
  // own URL. (useMemo + revoke-on-cleanup breaks under React StrictMode's
  // double-mount: the first cleanup revokes the memoized URL and the video
  // then loads a dead blob URL -> "Format error".)
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    setPlaybackError(null);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Poll the playhead instead of relying on timeupdate/seeked: during load,
  // a stray timeupdate at t=0 can land AFTER the initial programmatic seek's
  // events and freeze the synced caption on the wrong entry.
  useEffect(() => {
    if (!url) return;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (v && !v.seeking) setPlayheadT(v.currentTime);
    }, 250);
    return () => clearInterval(id);
  }, [url]);

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

  // Header caption: follow the playhead through the selected timeline when
  // timelines are available; otherwise the static clicked/shot caption.
  const timeline = source === "cloud" ? timelines?.cloud : timelines?.local;
  const synced = timeline && timeline.length > 0 ? captionAt(timeline, playheadT) : null;
  const headerCaption = synced?.text ?? preview.caption ?? shot.cloudCaption ?? shot.caption;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-background-secondary border border-border rounded-xl overflow-hidden max-w-4xl w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-4 py-2 gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{fileName}</p>
            <p className="text-xs text-text-secondary font-mono">
              shot {shot.index} · {fmtTime(shot.tStart)}–{fmtTime(shot.tEnd)}
              {pastEnd && " · past shot end"}
            </p>
            {headerCaption && (
              <p className="text-xs text-text-secondary/90 italic leading-snug mt-0.5">
                {synced && (
                  <span className="not-italic font-mono mr-1.5">{fmtTime(synced.t)}</span>
                )}
                {headerCaption}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {hasCloud && hasLocal && (
              <span className="inline-flex rounded border border-border overflow-hidden text-xs">
                {(["local", "cloud"] as const).map((v) => (
                  <button
                    key={v}
                    className={`px-1.5 py-0.5 ${
                      source === v
                        ? "bg-sky-500/20 text-sky-600"
                        : "text-text-secondary hover:bg-background"
                    }`}
                    onClick={() => setSource(v)}
                  >
                    {v}
                  </button>
                ))}
              </span>
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
        {playbackError && (
          <div className="px-4 py-6 text-sm text-text-secondary">
            <p className="text-text-primary mb-1">Can't play this file in the browser.</p>
            <p>
              {playbackError} — the clip is likely HEVC/H.265, which needs hardware
              codec support (Chrome on macOS/Windows usually has it). Analysis still
              works either way; this only affects preview playback.
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
            e.currentTarget.currentTime = startAtS;
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            // Pause once at the shot boundary; let the user scrub beyond it.
            if (!pastEnd && v.currentTime >= shot.tEnd) {
              v.pause();
              setPastEnd(true);
            }
          }}
          onSeeked={(e) => {
            // Re-arm the boundary pause when the user scrubs back inside.
            if (e.currentTarget.currentTime < shot.tEnd) setPastEnd(false);
          }}
        />
        )}
      </div>
    </div>
  );
}
