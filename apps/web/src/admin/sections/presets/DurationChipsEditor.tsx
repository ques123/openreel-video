/**
 * Duration-chips editor: the public product's "Length" chip row
 * (PublishedPreset.targetDurationChoicesS), edited via add/remove — see
 * ../../lib/duration-chips.ts for the pure reducer (dedupe + ascending sort).
 */
import { useState } from "react";
import { durationChipsReducer } from "../../lib/duration-chips";

/** Exact seconds -> "30s" / "1m" / "1m 30s" — chip values are small, admin-authored numbers, so no rounding (unlike the lab's aggregate-seconds formatter). */
function fmtChipSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

export function DurationChipsEditor({
  durations,
  onChange,
}: {
  durations: number[];
  onChange: (next: number[]) => void;
}) {
  const [addValue, setAddValue] = useState(60);

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {durations.map((s) => (
          <span
            key={s}
            className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-text-primary"
          >
            {fmtChipSeconds(s)}
            <button
              type="button"
              onClick={() => onChange(durationChipsReducer(durations, { type: "remove", seconds: s }))}
              className="text-text-secondary hover:text-status-error"
              title={`remove ${fmtChipSeconds(s)}`}
            >
              ×
            </button>
          </span>
        ))}
        {durations.length === 0 && <span className="text-xs italic text-text-secondary">no chips yet</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          value={addValue}
          onChange={(e) => {
            const raw = e.target.valueAsNumber;
            if (!Number.isNaN(raw)) setAddValue(raw);
          }}
          className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-text-primary outline-none focus:border-primary"
        />
        <span className="text-xs text-text-secondary">seconds</span>
        <button
          type="button"
          onClick={() => onChange(durationChipsReducer(durations, { type: "add", seconds: addValue }))}
          className="rounded border border-border px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary"
        >
          + add chip
        </button>
      </div>
    </div>
  );
}
