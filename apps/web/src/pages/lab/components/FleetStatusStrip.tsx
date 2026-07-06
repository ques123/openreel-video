import type { FleetRollup } from "../clip-rollup";

interface FleetStatusStripProps {
  rollup: FleetRollup;
  /** Scroll the clip list to a row (the active clip's ▸ button). */
  onJumpToClip: (clipId: string) => void;
}

/**
 * One-line fleet rollup for large batches: per-status counts plus what the
 * serialized pipeline is chewing on right now — "91 clips · 78 done ·
 * 3 error · ▸ IMG_0042.MOV — scanning 62% · 9 queued". The active-clip
 * segment is a button that scrolls its row into view.
 */
export function FleetStatusStrip({ rollup, onJumpToClip }: FleetStatusStripProps) {
  if (rollup.total === 0) return null;
  const active = rollup.active;
  return (
    <p className="text-xs text-text-secondary mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="text-text-primary">{rollup.done} done</span>
      {rollup.error > 0 && <span className="text-red-400">{rollup.error} error</span>}
      {rollup.cancelled > 0 && <span>{rollup.cancelled} cancelled</span>}
      {rollup.analyzing > 0 &&
        (active ? (
          <button
            className="text-sky-600 hover:underline text-left"
            onClick={() => onJumpToClip(active.clipId)}
            title={`Scroll to ${active.fileName}`}
          >
            ▸ {rollup.analyzing > 1 ? `${rollup.analyzing} analyzing · ` : ""}
            {active.fileName} — {active.stage}
          </button>
        ) : (
          <span className="text-sky-600">{rollup.analyzing} analyzing</span>
        ))}
      {rollup.queued > 0 && <span>{rollup.queued} queued</span>}
      {rollup.describing && (
        <span title="Background scene descriptions (local FastVLM) still running on finished clips">
          describing {rollup.describing.done}/{rollup.describing.total}
        </span>
      )}
    </p>
  );
}
