/**
 * Per-user quota override editor: one row per QuotaCategory, each either
 * inheriting the global default or overridden to a number / "unlimited"
 * (wire value null — see lib/quota-drafts.ts's file header for exactly how
 * that maps against services/gateway's sparse-merge PATCH semantics).
 * Purely presentational/controlled — UserDetailPanel owns the draft state
 * and the save/clear-all actions.
 */
import { QUOTA_CATEGORIES } from "@wizz/contracts";
import { quotaCategoryLabel } from "../../lib/format";
import type { QuotaOverrideDraft, QuotaOverrideDraftState } from "../../lib/quota-drafts";

export function QuotaOverridesEditor({
  draft,
  onChange,
  disabled,
}: {
  draft: QuotaOverrideDraft;
  onChange: (next: QuotaOverrideDraft) => void;
  disabled?: boolean;
}) {
  const setCategory = (category: keyof QuotaOverrideDraft, patch: Partial<QuotaOverrideDraftState>) => {
    onChange({ ...draft, [category]: { ...draft[category], ...patch } });
  };

  return (
    <div className="space-y-1.5">
      {QUOTA_CATEGORIES.map((category) => {
        const state = draft[category];
        return (
          <div key={category} className="flex items-center gap-2 text-xs">
            <label className="flex w-64 shrink-0 items-center gap-1.5 text-text-secondary">
              <input
                type="checkbox"
                checked={state.overridden}
                disabled={disabled}
                onChange={(e) =>
                  setCategory(category, { overridden: e.target.checked, unlimited: false })
                }
              />
              {quotaCategoryLabel(category)}
            </label>
            <input
              type="number"
              min={0}
              step={1}
              value={state.value}
              disabled={disabled || !state.overridden || state.unlimited}
              onChange={(e) => {
                const raw = e.target.valueAsNumber;
                if (Number.isNaN(raw)) return;
                setCategory(category, { value: Math.max(0, Math.round(raw)) });
              }}
              className="w-28 rounded border border-border bg-background px-1.5 py-0.5 text-text-primary outline-none focus:border-primary disabled:opacity-40"
            />
            <label className="flex items-center gap-1 text-text-secondary">
              <input
                type="checkbox"
                checked={state.unlimited}
                disabled={disabled || !state.overridden}
                onChange={(e) => setCategory(category, { unlimited: e.target.checked })}
              />
              unlimited
            </label>
          </div>
        );
      })}
      <p className="text-[10px] text-text-secondary/70">
        unchecked categories inherit the System section&rsquo;s global default. &ldquo;unlimited&rdquo; clears
        this user&rsquo;s override back to that default (today every default is unlimited, so the two read the
        same — this stays meaningful once a finite default ever ships).
      </p>
    </div>
  );
}
