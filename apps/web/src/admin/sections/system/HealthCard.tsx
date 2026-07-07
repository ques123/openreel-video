/**
 * Health card, auto-refreshing every 10s. Independent fetch from the
 * settings/kill-switch controls above it — its `killSwitch` echo is a
 * cross-check that the two ever agree, not a shared data source.
 */
import { useEffect, useState } from "react";
import type { AdminHealth } from "@wizz/contracts";
import { adminGetHealth } from "../../../services/gateway";
import { AdminProbeResult, type ProbeState } from "../../AdminProbeResult";
import { fmtBytes, fmtDurationHM } from "../../lib/format";

const REFRESH_MS = 10_000;

export function HealthCard() {
  const [state, setState] = useState<ProbeState<AdminHealth>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      adminGetHealth()
        .then((data) => {
          if (!cancelled) setState({ status: "ok", data });
        })
        .catch((error: unknown) => {
          if (!cancelled) setState({ status: "error", error });
        });
    };
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="rounded-md border border-border bg-background-secondary p-3">
      <h3 className="mb-1.5 text-xs font-semibold text-text-primary">
        Health <span className="font-normal text-text-secondary">(refreshes every 10s)</span>
      </h3>
      <AdminProbeResult
        state={state}
        render={(h) => (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-text-secondary">ok</dt>
            <dd className={h.ok ? "text-status-success" : "text-status-error"}>{String(h.ok)}</dd>
            <dt className="text-text-secondary">version</dt>
            <dd className="text-text-primary">{h.version}</dd>
            <dt className="text-text-secondary">uptime</dt>
            <dd className="text-text-primary">{fmtDurationHM(h.uptimeS)}</dd>
            <dt className="text-text-secondary">kill switch</dt>
            <dd className={h.killSwitch ? "text-status-error" : "text-text-primary"}>{String(h.killSwitch)}</dd>
            <dt className="text-text-secondary">db size</dt>
            <dd className="text-text-primary">{fmtBytes(h.db.sizeBytes)}</dd>
            <dt className="text-text-secondary">users</dt>
            <dd className="text-text-primary">{h.db.users}</dd>
            <dt className="text-text-secondary">usage events</dt>
            <dd className="text-text-primary">{h.db.usageEvents}</dd>
          </dl>
        )}
      />
    </div>
  );
}
