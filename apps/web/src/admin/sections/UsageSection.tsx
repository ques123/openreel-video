/**
 * Wave-2 stub: the real Usage & Spend rollup dashboard (PerfPanel idioms,
 * exact-$ cost-truth conventions) lands here. For now this proves the
 * gateway plumbing end-to-end with one real call — see
 * AdminProbeResult/SectionPage.
 */
import { useEffect, useState } from "react";
import type { UsageRollupRow } from "@wizz/contracts";
import { adminGetUsage } from "../../services/gateway";
import { AdminProbeResult, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";

export function UsageSection() {
  const [state, setState] = useState<ProbeState<{ rows: UsageRollupRow[] }>>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    adminGetUsage({ groupBy: ["day"] })
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
      title="Usage & Spend"
      description={
        <>
          Wave-2 stub — daily/provider/model rollups and exact-$ spend land here. This
          already calls <code className="font-mono">GET /api/admin/usage</code> through
          the gateway service layer.
        </>
      }
    >
      <AdminProbeResult
        state={state}
        render={(data) => (
          <p className="font-mono text-sm text-text-primary">
            {data.rows.length} usage row(s) returned by the gateway.
          </p>
        )}
      />
    </SectionPage>
  );
}
