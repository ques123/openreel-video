/**
 * Wave-2 stub: global default quotas, the kill switch, invite codes, and
 * settings editing land here. For now this proves the gateway plumbing
 * end-to-end with one real call (adminGetHealth) — see
 * AdminProbeResult/SectionPage.
 */
import { useEffect, useState } from "react";
import type { AdminHealth } from "@wizz/contracts";
import { adminGetHealth } from "../../services/gateway";
import { AdminProbeResult, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";

export function SystemSection() {
  const [state, setState] = useState<ProbeState<AdminHealth>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    adminGetHealth()
      .then((data) => {
        if (!cancelled) setState({ status: "ok", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SectionPage
      title="System"
      description={
        <>
          Wave-2 stub — global default quotas, the kill switch, invite codes, and
          settings editing land here. This already calls{" "}
          <code className="font-mono">GET /api/admin/health</code> through the gateway
          service layer.
        </>
      }
    >
      <AdminProbeResult
        state={state}
        render={(data) => (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm text-text-primary">
            <dt className="text-text-secondary">ok</dt>
            <dd>{String(data.ok)}</dd>
            <dt className="text-text-secondary">version</dt>
            <dd>{data.version}</dd>
            <dt className="text-text-secondary">uptimeS</dt>
            <dd>{data.uptimeS}</dd>
            <dt className="text-text-secondary">killSwitch</dt>
            <dd>{String(data.killSwitch)}</dd>
            <dt className="text-text-secondary">db.users</dt>
            <dd>{data.db.users}</dd>
          </dl>
        )}
      />
    </SectionPage>
  );
}
