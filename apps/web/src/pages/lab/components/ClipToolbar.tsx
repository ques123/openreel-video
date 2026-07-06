import type { FleetRollup, StatusFilter } from "../clip-rollup";

interface ClipToolbarProps {
  rollup: FleetRollup;
  nameQuery: string;
  onNameQueryChange: (query: string) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (filter: StatusFilter) => void;
  /** Rows currently rendered after filtering. */
  shownCount: number;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}

/** Count for one status-filter option (for "(n)" labels in the select). */
function countFor(rollup: FleetRollup, filter: StatusFilter): number {
  return filter === "all" ? rollup.total : rollup[filter];
}

const FILTER_OPTIONS: StatusFilter[] = [
  "all",
  "done",
  "error",
  "cancelled",
  "analyzing",
  "queued",
];

/**
 * Compact list controls for large batches: name filter, status filter and
 * collapse/expand-all. Session-only state — nothing here persists.
 */
export function ClipToolbar({
  rollup,
  nameQuery,
  onNameQueryChange,
  statusFilter,
  onStatusFilterChange,
  shownCount,
  onCollapseAll,
  onExpandAll,
}: ClipToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <input
        type="search"
        value={nameQuery}
        onChange={(e) => onNameQueryChange(e.target.value)}
        placeholder="filter by name…"
        className="px-2 py-1 rounded border border-border bg-background text-text-primary placeholder:text-text-secondary/70 w-44"
      />
      <select
        value={statusFilter}
        onChange={(e) => onStatusFilterChange(e.target.value as StatusFilter)}
        className="px-1.5 py-1 rounded border border-border bg-background text-text-secondary"
        title="Show only clips in this state"
      >
        {FILTER_OPTIONS.map((f) => (
          <option key={f} value={f}>
            {f} ({countFor(rollup, f)})
          </option>
        ))}
      </select>
      <span className="inline-flex rounded border border-border overflow-hidden">
        <button
          className="px-1.5 py-1 text-text-secondary hover:bg-background-secondary"
          onClick={onCollapseAll}
          title="Collapse every clip to its header line (filmstrips unload)"
        >
          collapse all
        </button>
        <button
          className="px-1.5 py-1 text-text-secondary hover:bg-background-secondary border-l border-border"
          onClick={onExpandAll}
          title="Expand every clip's filmstrip"
        >
          expand all
        </button>
      </span>
      {shownCount !== rollup.total && (
        <span className="text-text-secondary">
          {shownCount} of {rollup.total} clip{rollup.total === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}
