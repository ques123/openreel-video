import { useEffect, useRef, useState } from "react";
import type { TranscriptSegment } from "@openreel/core";
import { GROQ_WHISPER_MODEL } from "../../../services/groq-stt";
import type { LabClip } from "../use-perception-lab";
import { activeSegmentIndex, fmtColumnFooter, fmtSegTime } from "./transcript-compare";

interface TranscriptCompareModalProps {
  clip: LabClip;
  /** The clip's local whisper checkpoint — the dossier doesn't record which
   * one produced its transcript, so this is the CURRENT setting (the best
   * available label; can read stale if it changed since this clip ran). */
  localModel: "base" | "large-v3-turbo";
  /**
   * All lab clips, for paging between comparisons (prev/next buttons and
   * ←/→ keys) without close-and-reopen per clip. Optional together with
   * onSelectClip — omit both and the pager is hidden. Mirrors
   * CaptionCompareModal's pager.
   */
  clips?: LabClip[];
  onSelectClip?: (clip: LabClip) => void;
  onClose: () => void;
  /** Resolve a clip's original File for playback (the hook's getFile). */
  getFile: (clipId: string) => File | null;
}

interface Column {
  key: string;
  label: string;
  segments: TranscriptSegment[];
  footer: string;
  emptyHint: string | null;
}

/**
 * One scrollable segment column. Autoscroll fires ONLY when `activeIndex`
 * changes (the effect's dependency), never on every timeupdate tick that
 * leaves it unchanged — so a user manually scrolling the list while a long
 * segment is active is never fought.
 */
function TranscriptColumn({ column, activeIndex, onSeek }: {
  column: Column;
  activeIndex: number;
  onSeek: (t: number) => void;
}) {
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-3 py-1.5 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text-secondary">{column.label}</span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-1">
        {column.segments.length === 0 ? (
          <p className="text-xs text-text-secondary p-2">{column.emptyHint}</p>
        ) : (
          <ul className="space-y-0.5">
            {column.segments.map((seg, i) => (
              <li
                key={i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                className={`text-xs leading-relaxed rounded px-1.5 py-1 cursor-pointer ${
                  i === activeIndex
                    ? "bg-sky-500/15 text-text-primary ring-1 ring-sky-500/40"
                    : "text-text-secondary hover:bg-background hover:text-text-primary"
                }`}
                onClick={() => onSeek(seg.t0)}
              >
                <span className="font-mono text-[10px] mr-1.5 opacity-80">
                  {fmtSegTime(seg.t0)} → {fmtSegTime(seg.t1)}
                </span>
                {seg.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-secondary shrink-0">
        {column.footer}
      </div>
    </div>
  );
}

/**
 * Local-vs-cloud transcript comparison with synced video playback: a
 * `<video>` on the left (the clip's own File — object URL, revoked on
 * unmount/clip change) and two scrollable segment columns on the right. The
 * segment covering the video's current time is highlighted in both columns
 * (timeupdate-driven) and auto-scrolled into view; clicking any segment
 * seeks the video to its start. The cloud column always renders (so its
 * header states which model it WOULD use) but shows a hint instead of
 * segments when this clip has no cloudTranscript yet.
 */
export function TranscriptCompareModal({
  clip,
  localModel,
  clips,
  onSelectClip,
  onClose,
  getFile,
}: TranscriptCompareModalProps) {
  const dossier = clip.dossier;
  const cloudTranscript = dossier?.cloudTranscript ?? null;

  // Page only across clips with a local transcript worth comparing — same
  // filter the ClipRowBar affordance uses to decide whether to render.
  const pageable = clips && onSelectClip ? clips.filter((c) => c.transcript.length > 0) : null;
  const pageIndex = pageable ? pageable.findIndex((c) => c.clipId === clip.clipId) : -1;
  const goTo = (delta: number) => {
    if (!pageable || !onSelectClip || pageIndex < 0) return;
    const next = pageable[pageIndex + delta];
    if (next) onSelectClip(next);
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [currentTimeS, setCurrentTimeS] = useState(0);

  // Create AND revoke the object URL inside one effect keyed on the file
  // reference (same convention as ShotPreviewModal) — survives React
  // StrictMode's double-mount and re-runs cleanly when paging to another clip.
  useEffect(() => {
    const file = getFile(clip.clipId);
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    setCurrentTimeS(0);
    return () => URL.revokeObjectURL(u);
  }, [clip.clipId, getFile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const t = e.target as HTMLElement | null;
        // Never hijack arrows aimed at a text field, OR at the video itself
        // (a focused <video>'s native seek-by-5s shortcut takes priority over
        // clip paging — this modal is the first to combine both).
        if (
          t &&
          (t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.tagName === "VIDEO" ||
            t.isContentEditable)
        ) {
          return;
        }
        e.stopPropagation();
        goTo(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // goTo closes over pageable/pageIndex, re-created per render — cheap
    // listener, re-attached every render keeps it current (matches
    // CaptionCompareModal's identical pattern).
  });

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    setCurrentTimeS(t);
  };

  const localColumn: Column = {
    key: "local",
    label: `local (whisper-${localModel})`,
    segments: clip.transcript,
    footer: fmtColumnFooter(clip.transcript),
    emptyHint: "No local transcript for this clip yet.",
  };
  const cloudColumn: Column = {
    key: "cloud",
    label: `cloud (${GROQ_WHISPER_MODEL})`,
    segments: cloudTranscript?.segments ?? [],
    footer: cloudTranscript
      ? fmtColumnFooter(cloudTranscript.segments, cloudTranscript.words?.length, {
          billedSeconds: cloudTranscript.billedSeconds,
          costUSD: cloudTranscript.costUSD,
          ms: cloudTranscript.ms,
        })
      : "",
    emptyHint: "enable cloud transcription to compare",
  };

  const localActiveIndex = activeSegmentIndex(localColumn.segments, currentTimeS);
  const cloudActiveIndex = activeSegmentIndex(cloudColumn.segments, currentTimeS);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-background-secondary border border-border rounded-xl overflow-hidden max-w-6xl w-full flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              {clip.fileName} — transcript comparison
            </p>
            <p className="text-xs text-text-secondary">
              {localColumn.segments.length} local segment
              {localColumn.segments.length === 1 ? "" : "s"}
              {cloudTranscript ? ` · cloud model: ${cloudTranscript.model}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {pageable && pageIndex >= 0 && (
              <div className="flex items-center gap-1 text-xs text-text-secondary">
                <button
                  className="px-1.5 py-0.5 rounded border border-border hover:text-text-primary disabled:opacity-30"
                  disabled={pageIndex <= 0}
                  onClick={() => goTo(-1)}
                  title="Previous clip (←)"
                  aria-label="Previous clip"
                >
                  ‹
                </button>
                <span className="font-mono">
                  {pageIndex + 1}/{pageable.length}
                </span>
                <button
                  className="px-1.5 py-0.5 rounded border border-border hover:text-text-primary disabled:opacity-30"
                  disabled={pageIndex >= pageable.length - 1}
                  onClick={() => goTo(1)}
                  title="Next clip (→)"
                  aria-label="Next clip"
                >
                  ›
                </button>
              </div>
            )}
            <button
              className="text-text-secondary hover:text-text-primary text-xl px-2"
              onClick={onClose}
              aria-label="Close comparison"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-2 min-h-0">
          <div className="bg-black flex items-center justify-center min-h-0 border-r border-border">
            {url ? (
              <video
                ref={videoRef}
                src={url}
                controls
                playsInline
                className="w-full max-h-full"
                onTimeUpdate={(e) => setCurrentTimeS(e.currentTarget.currentTime)}
                onSeeked={(e) => setCurrentTimeS(e.currentTarget.currentTime)}
              />
            ) : (
              <p className="text-xs text-text-secondary p-4">
                Original file not available in this session — re-drop it to play back.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 min-h-0 divide-x divide-border">
            <TranscriptColumn column={localColumn} activeIndex={localActiveIndex} onSeek={seek} />
            <TranscriptColumn column={cloudColumn} activeIndex={cloudActiveIndex} onSeek={seek} />
          </div>
        </div>
      </div>
    </div>
  );
}
