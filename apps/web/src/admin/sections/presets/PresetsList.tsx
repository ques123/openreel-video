/**
 * The Presets list: name, version, active badge, publishedAt. Row click
 * loads that preset into the editor form (PresetsSection owns selection).
 */
import type { PublishedPreset } from "@wizz/contracts";
import { fmtDateTime } from "../../lib/format";

export function PresetsList({
  presets,
  activePresetId,
  selectedId,
  onSelect,
}: {
  presets: PublishedPreset[];
  activePresetId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (presets.length === 0) {
    return <p className="text-sm text-text-secondary">No presets yet — create one to get started.</p>;
  }

  return (
    <ul className="space-y-1">
      {presets.map((p) => {
        const selected = p.id === selectedId;
        const active = p.id === activePresetId;
        return (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className={
                "w-full rounded border px-2 py-1.5 text-left text-xs " +
                (selected
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-background-secondary")
              }
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate text-text-primary">{p.name}</span>
                {active && (
                  <span className="shrink-0 rounded bg-status-success/20 px-1.5 py-0.5 text-[10px] font-medium text-status-success">
                    active
                  </span>
                )}
              </span>
              <span className="block font-mono text-[10px] text-text-secondary">
                v{p.version} · published {fmtDateTime(p.publishedAt)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
