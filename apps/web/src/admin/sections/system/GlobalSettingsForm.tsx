/**
 * GlobalSettings editor: default quotas per category, the footage cap, and
 * the invite-required toggle. `killSwitch` and `activePresetId` are part of
 * the same PUT body (the endpoint always takes the whole object) but are
 * deliberately NOT edited here — killSwitch has its own prominent control
 * (KillSwitchControl) and activePresetId changes only via the Presets
 * section's Activate action; this form passes both through unchanged.
 */
import { useEffect, useState } from "react";
import { QUOTA_CATEGORIES, type GlobalSettings, type QuotaCategory } from "@wizz/contracts";
import { adminPutSettings } from "../../../services/gateway";
import { describeProbeError } from "../../AdminProbeResult";
import { fmtDurationHM, quotaCategoryLabel } from "../../lib/format";
import { draftToQuotaLimits, quotaLimitsToDraft, type QuotaLimitsDraft } from "../../lib/quota-drafts";

export function GlobalSettingsForm({ settings, onSaved }: { settings: GlobalSettings; onSaved: () => void }) {
  const [quotaDraft, setQuotaDraft] = useState<QuotaLimitsDraft>(() => quotaLimitsToDraft(settings.defaultQuotas));
  const [maxClips, setMaxClips] = useState(settings.footageCap.maxClips);
  const [maxTotalSeconds, setMaxTotalSeconds] = useState(settings.footageCap.maxTotalSeconds);
  const [inviteRequired, setInviteRequired] = useState(settings.inviteRequired);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    setQuotaDraft(quotaLimitsToDraft(settings.defaultQuotas));
    setMaxClips(settings.footageCap.maxClips);
    setMaxTotalSeconds(settings.footageCap.maxTotalSeconds);
    setInviteRequired(settings.inviteRequired);
    setSaveError(null);
    // Re-sync whenever the server's copy changes (including after the kill switch's own PUT elsewhere).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(settings)]);

  const setCategory = <K extends QuotaCategory>(category: K, patch: Partial<QuotaLimitsDraft[K]>) =>
    setQuotaDraft((prev) => ({ ...prev, [category]: { ...prev[category], ...patch } }));

  const invalid = maxClips <= 0 || maxTotalSeconds <= 0;

  const save = () => {
    setSaving(true);
    setSaveError(null);
    adminPutSettings({
      ...settings, // pass killSwitch + activePresetId through unchanged
      defaultQuotas: draftToQuotaLimits(quotaDraft),
      footageCap: { maxClips, maxTotalSeconds },
      inviteRequired,
    })
      .then(() => onSaved())
      .catch((error: unknown) => setSaveError(error))
      .finally(() => setSaving(false));
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-1 text-xs font-semibold text-text-primary">Default quotas (per category, per day)</h3>
        <div className="space-y-1.5">
          {QUOTA_CATEGORIES.map((category) => {
            const s = quotaDraft[category];
            return (
              <div key={category} className="flex items-center gap-2 text-xs">
                <span className="w-64 shrink-0 text-text-secondary">{quotaCategoryLabel(category)}</span>
                <input
                  type="number"
                  min={0}
                  value={s.value}
                  disabled={s.unlimited}
                  onChange={(e) => {
                    const v = e.target.valueAsNumber;
                    if (!Number.isNaN(v)) setCategory(category, { value: Math.max(0, Math.round(v)) });
                  }}
                  className="w-28 rounded border border-border bg-background px-1.5 py-0.5 text-text-primary outline-none focus:border-primary disabled:opacity-40"
                />
                <label className="flex items-center gap-1 text-text-secondary">
                  <input
                    type="checkbox"
                    checked={s.unlimited}
                    onChange={(e) => setCategory(category, { unlimited: e.target.checked })}
                  />
                  unlimited
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold text-text-primary">Per-generate footage cap</h3>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-text-secondary">
            max clips
            <input
              type="number"
              min={1}
              value={maxClips}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (!Number.isNaN(v)) setMaxClips(Math.max(1, Math.round(v)));
              }}
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-text-primary outline-none focus:border-primary"
            />
          </label>
          <label className="flex items-center gap-1.5 text-text-secondary">
            max total seconds
            <input
              type="number"
              min={1}
              value={maxTotalSeconds}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (!Number.isNaN(v)) setMaxTotalSeconds(Math.max(1, Math.round(v)));
              }}
              className="w-24 rounded border border-border bg-background px-1.5 py-0.5 text-text-primary outline-none focus:border-primary"
            />
          </label>
          <span className="font-mono text-[11px] text-text-secondary/70">
            ≈ {fmtDurationHM(maxTotalSeconds)} of footage
          </span>
        </div>
        {invalid && <p className="mt-1 text-[11px] text-status-error">both values must be positive</p>}
      </div>

      <label className="flex items-start gap-1.5 text-xs text-text-secondary">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={inviteRequired}
          onChange={(e) => setInviteRequired(e.target.checked)}
        />
        <span>
          Invite required for signup
          <span className="block text-[10px] text-status-warning">
            v1 default is true — flipping this off opens public signup without a code (not currently used
            operationally).
          </span>
        </span>
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || invalid}
          className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {saving ? "saving…" : "Save settings"}
        </button>
        {saveError !== null && <p className="text-xs text-status-error">{describeProbeError(saveError)}</p>}
      </div>
    </div>
  );
}
