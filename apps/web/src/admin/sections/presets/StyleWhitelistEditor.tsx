/**
 * Ordered style-whitelist checkboxes over the full STYLE_PRESETS catalog
 * (@openreel/core, 11 authored voices). Checkbox layout is the catalog's own
 * fixed order (easiest to scan/find something in); the SAVED array preserves
 * the order ids were checked in (see ../../lib/style-whitelist.ts) — shown
 * explicitly below the checkboxes since checkbox layout alone can't convey
 * that order.
 */
import { STYLE_PRESETS } from "@openreel/core";
import { toggleStyleWhitelistId } from "../../lib/style-whitelist";

export function StyleWhitelistEditor({
  whitelist,
  onChange,
}: {
  whitelist: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {STYLE_PRESETS.map((sp) => {
          const checked = whitelist.includes(sp.id);
          return (
            <label
              key={sp.id}
              className="flex items-start gap-2 rounded border border-border px-2 py-1.5 text-xs"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={checked}
                onChange={(e) => onChange(toggleStyleWhitelistId(whitelist, sp.id, e.target.checked))}
              />
              <span>
                <span className="block text-text-primary">{sp.label}</span>
                <span className="block text-text-secondary">{sp.tagline}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-text-secondary">
        Public display order:{" "}
        {whitelist.length > 0 ? (
          <span className="font-mono text-text-primary">
            {whitelist.map((id) => STYLE_PRESETS.find((sp) => sp.id === id)?.label ?? id).join(" → ")}
          </span>
        ) : (
          <span className="italic">none selected — the director chooses freely</span>
        )}
      </p>
    </div>
  );
}
