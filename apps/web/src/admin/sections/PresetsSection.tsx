/**
 * Wave-2 stub: editing/publishing the public preset (style whitelist,
 * locked LabSettings) lands here. For now this proves the gateway plumbing
 * end-to-end with one real call — see AdminProbeResult/SectionPage.
 */
import { useEffect, useState } from "react";
import type { PublishedPreset } from "@wizz/contracts";
import { adminListPresets } from "../../services/gateway";
import { AdminProbeResult, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";

export function PresetsSection() {
  const [state, setState] = useState<ProbeState<{ presets: PublishedPreset[] }>>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    adminListPresets()
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
      title="Presets"
      description={
        <>
          Wave-2 stub — editing/publishing the public preset (style whitelist, locked
          LabSettings) lands here. This already calls{" "}
          <code className="font-mono">GET /api/admin/presets</code> through the gateway
          service layer.
        </>
      }
    >
      <AdminProbeResult
        state={state}
        render={(data) => (
          <p className="font-mono text-sm text-text-primary">
            {data.presets.length} preset(s) returned by the gateway.
          </p>
        )}
      />
    </SectionPage>
  );
}
