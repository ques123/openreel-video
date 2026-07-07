import type { LabClip } from "../use-perception-lab";
import { fmtClipTime, stageLabelOf, type DerivedClipStatus } from "../clip-rollup";
import { ConfirmButton } from "./ConfirmButton";

interface ClipRowBarProps {
  clip: LabClip;
  /** Queue-aware status ("analyzing" here = actively processing). */
  derivedStatus: DerivedClipStatus;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Cancel was clicked but the orchestrator hasn't acknowledged yet. */
  cancelPending: boolean;
  /** Non-null on analyzing/queued rows: abort this clip's analysis. */
  onCancel: (() => void) | null;
  onRemove: () => void;
  /** Collapsed-row bulk-enhance checkbox state; null = selection UI off. */
  selected: boolean | null;
  onSelectChange?: (checked: boolean) => void;
  /**
   * Non-null once this clip has a local transcript worth viewing (done +
   * clip.transcript.length > 0) — opens TranscriptCompareModal at the page
   * level. Null hides the affordance entirely.
   */
  onOpenTranscripts: (() => void) | null;
  /** Retry a failed cloud transcription for this clip (cloudTranscribeClip). */
  onRetryCloudTranscribe: () => void;
}

/**
 * Compact per-clip transcript affordance: a "transcripts" button once a
 * local transcript exists (opens the compare modal), plus the SEPARATE
 * opt-in cloud transcription tier's own progress/error status inline — done
 * doesn't need its own indicator here since the modal's cloud column already
 * shows it. Lives in ClipRowBar (not ShotFilmstrip) because it renders
 * identically in both the collapsed and expanded row layouts.
 */
function TranscriptAction({
  cloudTranscribe,
  onOpenTranscripts,
  onRetryCloudTranscribe,
}: {
  cloudTranscribe: LabClip["cloudTranscribe"];
  onOpenTranscripts: (() => void) | null;
  onRetryCloudTranscribe: () => void;
}) {
  if (!onOpenTranscripts) return null;
  return (
    <span className="flex items-center gap-1 shrink-0">
      <button
        className="text-xs px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary"
        onClick={onOpenTranscripts}
        title="Compare local vs. cloud transcripts with video playback"
      >
        transcripts
      </button>
      {cloudTranscribe?.status === "queued" && (
        <span className="text-[10px] text-text-secondary">cloud queued…</span>
      )}
      {cloudTranscribe?.status === "running" && (
        <span className="text-[10px] text-sky-600">cloud transcribing…</span>
      )}
      {cloudTranscribe?.status === "error" && (
        <span className="text-[10px] text-red-400" title={cloudTranscribe.error}>
          cloud failed —{" "}
          <button
            className="underline hover:text-red-300"
            onClick={onRetryCloudTranscribe}
            title="Retry cloud transcription for this clip"
          >
            retry
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * Status badges shared by both row modes: queue position / live stage,
 * cancelled marker, stale-cache re-analysis label, and VISIBLE error text
 * (analysis errors only when collapsed — the expanded filmstrip already
 * shows those inline — but cloud-enhance failures always, since the
 * filmstrip only tooltips them).
 */
function StatusBadges({
  clip,
  derivedStatus,
  collapsed,
}: Pick<ClipRowBarProps, "clip" | "derivedStatus" | "collapsed">) {
  return (
    <>
      {clip.staleReanalysis && (derivedStatus === "analyzing" || derivedStatus === "queued") && (
        <span
          className="text-[10px] px-1 rounded border border-amber-500/60 text-amber-500 shrink-0"
          title="A cached analysis of this file exists but was invalidated by a pipeline update (DOSSIER_VERSION bump) — this is a re-analysis, not a new clip"
        >
          re-analyzing (pipeline updated)
        </span>
      )}
      {derivedStatus === "queued" && (
        <span className="text-xs text-text-secondary shrink-0" title="Waiting for the serialized analysis queue">
          queued
        </span>
      )}
      {derivedStatus === "analyzing" && (
        <span className="text-xs text-sky-600 shrink-0">{stageLabelOf(clip)}</span>
      )}
      {derivedStatus === "cancelled" && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-background text-text-secondary border border-border shrink-0">
          cancelled
        </span>
      )}
      {collapsed && derivedStatus === "error" && (
        <span className="text-xs text-red-400 truncate" title={clip.error}>
          error: {clip.error}
        </span>
      )}
      {clip.cloud?.error && (
        <span className="text-xs text-red-400 truncate" title={clip.cloud.error}>
          cloud enhance failed: {clip.cloud.error}
        </span>
      )}
    </>
  );
}

function RowActions({
  clip,
  derivedStatus,
  cancelPending,
  onCancel,
  onRemove,
}: Pick<ClipRowBarProps, "clip" | "derivedStatus" | "cancelPending" | "onCancel" | "onRemove">) {
  const cancellable = derivedStatus === "analyzing" || derivedStatus === "queued";
  return (
    <>
      {onCancel && cancellable && (
        <button
          className="text-xs px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-red-400 hover:border-red-500/40 disabled:opacity-40 disabled:cursor-default shrink-0"
          onClick={onCancel}
          disabled={cancelPending}
          title="Cancel this clip's analysis (partial work is discarded; the queue moves on)"
        >
          {cancelPending ? "cancelling…" : "✕ cancel"}
        </button>
      )}
      <ConfirmButton
        className="text-xs px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-red-400 hover:border-red-500/40 shrink-0"
        armedClassName="border-red-500/60 text-red-400"
        confirmLabel="remove?"
        onConfirm={onRemove}
        title={`Remove ${clip.fileName} from this session (cached analysis stays on disk — re-dropping it is instant)`}
      >
        remove
      </ConfirmButton>
    </>
  );
}

/**
 * Per-clip row chrome the filmstrip card doesn't own: collapse toggle,
 * queue/stage/cancelled/re-analysis badges, visible error text, and the
 * cancel/remove actions. Two modes:
 *
 * - collapsed: a self-contained header line (name, meta, status, actions) —
 *   the filmstrip below it is NOT rendered at all, which is what unloads
 *   its hundreds of inline base64 frames;
 * - expanded: a slim strip above the filmstrip card carrying only what the
 *   card lacks (the card renders its own name/meta/progress).
 */
export function ClipRowBar({
  clip,
  derivedStatus,
  collapsed,
  onToggleCollapse,
  cancelPending,
  onCancel,
  onRemove,
  selected,
  onSelectChange,
  onOpenTranscripts,
  onRetryCloudTranscribe,
}: ClipRowBarProps) {
  const caret = (
    <button
      className="text-xs text-text-secondary hover:text-text-primary shrink-0 w-4"
      onClick={onToggleCollapse}
      title={collapsed ? "Expand filmstrip" : "Collapse to header line"}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );

  if (!collapsed) {
    return (
      <div className="flex items-center gap-2 px-1 mb-1 min-w-0">
        {caret}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusBadges clip={clip} derivedStatus={derivedStatus} collapsed={false} />
        </div>
        <TranscriptAction
          cloudTranscribe={clip.cloudTranscribe}
          onOpenTranscripts={onOpenTranscripts}
          onRetryCloudTranscribe={onRetryCloudTranscribe}
        />
        <RowActions
          clip={clip}
          derivedStatus={derivedStatus}
          cancelPending={cancelPending}
          onCancel={onCancel}
          onRemove={onRemove}
        />
      </div>
    );
  }

  return (
    <div className="bg-background-secondary border border-border rounded-lg px-3 py-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        {caret}
        {selected !== null && clip.status === "done" && (
          <input
            type="checkbox"
            className="shrink-0 accent-sky-600"
            checked={selected}
            onChange={(e) => onSelectChange?.(e.target.checked)}
            title="Include this clip in 'enhance selected' (shift-click selects a range)"
          />
        )}
        <span className="font-medium text-text-primary truncate">{clip.fileName}</span>
        <span className="text-xs text-text-secondary shrink-0">
          {clip.durationS > 0 && `${fmtClipTime(clip.durationS)} · `}
          {(clip.fileSize / 1e6).toFixed(0)}MB
        </span>
        <StatusBadges clip={clip} derivedStatus={derivedStatus} collapsed />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {clip.shots.length > 0 && (
          <span className="text-xs text-text-secondary">
            {clip.shots.length} shot{clip.shots.length === 1 ? "" : "s"}
          </span>
        )}
        <TranscriptAction
          cloudTranscribe={clip.cloudTranscribe}
          onOpenTranscripts={onOpenTranscripts}
          onRetryCloudTranscribe={onRetryCloudTranscribe}
        />
        <RowActions
          clip={clip}
          derivedStatus={derivedStatus}
          cancelPending={cancelPending}
          onCancel={onCancel}
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}
