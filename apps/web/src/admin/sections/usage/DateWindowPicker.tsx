/**
 * today/7d/30d/custom date-window picker for the Usage & Spend rollup query.
 */
import type { DateRangePreset } from "../../lib/usage-rollup";

const PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "custom", label: "custom" },
];

export function DateWindowPicker({
  preset,
  onPresetChange,
  custom,
  onCustomChange,
}: {
  preset: DateRangePreset;
  onPresetChange: (preset: DateRangePreset) => void;
  custom: { from: string; to: string };
  onCustomChange: (custom: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onPresetChange(p.value)}
          className={
            "rounded-full border px-2.5 py-1 text-xs " +
            (preset === p.value
              ? "border-primary bg-primary/10 text-text-primary"
              : "border-border text-text-secondary hover:text-text-primary")
          }
        >
          {p.label}
        </button>
      ))}
      {preset === "custom" && (
        <span className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="date"
            value={custom.from}
            onChange={(e) => onCustomChange({ ...custom, from: e.target.value })}
            className="rounded border border-border bg-background px-1.5 py-1 text-text-primary outline-none focus:border-primary"
          />
          <span>to</span>
          <input
            type="date"
            value={custom.to}
            onChange={(e) => onCustomChange({ ...custom, to: e.target.value })}
            className="rounded border border-border bg-background px-1.5 py-1 text-text-primary outline-none focus:border-primary"
          />
        </span>
      )}
    </div>
  );
}
