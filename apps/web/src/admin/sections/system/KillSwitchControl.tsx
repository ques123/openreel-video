/**
 * The global kill switch: a prominent 2-step ConfirmButton. Always acts on
 * the freshest known server truth (the `settings` prop, kept in sync by
 * SystemSection's refetch-after-every-mutation rule) rather than on
 * GlobalSettingsForm's possibly-unsaved local draft, so flipping it can
 * never silently discard OR silently apply an admin's in-progress edits
 * elsewhere on the page — it only ever changes `killSwitch` itself.
 */
import { useState } from "react";
import type { GlobalSettings } from "@wizz/contracts";
import { adminPutSettings } from "../../../services/gateway";
import { ConfirmButton } from "../../../pages/lab/components/ConfirmButton";
import { describeProbeError } from "../../AdminProbeResult";

export function KillSwitchControl({ settings, onToggled }: { settings: GlobalSettings; onToggled: () => void }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const on = settings.killSwitch;

  const toggle = () => {
    setWorking(true);
    setError(null);
    adminPutSettings({ ...settings, killSwitch: !on })
      .then(() => onToggled())
      .catch((e: unknown) => setError(e))
      .finally(() => setWorking(false));
  };

  return (
    <div
      className={
        "rounded-md border-2 p-3 " +
        (on ? "border-status-error bg-status-error/10" : "border-border bg-background-secondary")
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">
            Kill switch: <span className={on ? "text-status-error" : "text-status-success"}>{on ? "ON" : "off"}</span>
          </p>
          <p className="text-[11px] text-text-secondary">
            When on, every public <code className="font-mono">/api/proxy/*</code> call 503s (
            <code className="font-mono">kill_switch</code>) — the public UI shows "the director is taking a
            break." Admin/tailnet traffic is unaffected.
          </p>
        </div>
        <ConfirmButton
          onConfirm={toggle}
          disabled={working}
          className={
            "shrink-0 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-40 " +
            (on ? "bg-status-success text-white" : "bg-status-error text-white")
          }
          armedClassName="ring-2 ring-offset-1"
          confirmLabel="sure? click again"
        >
          {working ? "working…" : on ? "Turn off" : "Turn on"}
        </ConfirmButton>
      </div>
      {error !== null && <p className="mt-1.5 text-xs text-status-error">{describeProbeError(error)}</p>}
    </div>
  );
}
