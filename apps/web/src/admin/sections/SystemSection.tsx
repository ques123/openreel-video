/**
 * System: global default quotas, footage cap, invite requirement, the kill
 * switch, invite-code management, and health. See docs/wizz-video-plan.md
 * §WS-C and docs/wizz-contracts.md §2.
 */
import { useEffect, useState } from "react";
import type { GlobalSettings } from "@wizz/contracts";
import { adminGetSettings } from "../../services/gateway";
import { AdminProbeResult, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";
import { GlobalSettingsForm } from "./system/GlobalSettingsForm";
import { HealthCard } from "./system/HealthCard";
import { InvitesPanel } from "./system/InvitesPanel";
import { KillSwitchControl } from "./system/KillSwitchControl";

export function SystemSection() {
  const [state, setState] = useState<ProbeState<GlobalSettings>>({ status: "loading" });

  const load = () => {
    setState((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    adminGetSettings()
      .then((data) => setState({ status: "ok", data }))
      .catch((error: unknown) => setState({ status: "error", error }));
  };

  useEffect(load, []);

  return (
    <SectionPage
      title="System"
      description="Global default quotas, the footage cap, invite requirement, the kill switch, invite codes, and gateway health."
    >
      <AdminProbeResult
        state={state}
        render={(settings) => (
          <div className="space-y-4">
            <KillSwitchControl settings={settings} onToggled={load} />
            <HealthCard />
            <div className="rounded-md border border-border bg-background-secondary p-3">
              <h3 className="mb-2 text-xs font-semibold text-text-primary">Global settings</h3>
              <GlobalSettingsForm settings={settings} onSaved={load} />
            </div>
            <div className="rounded-md border border-border bg-background-secondary p-3">
              <h3 className="mb-2 text-xs font-semibold text-text-primary">Invite codes</h3>
              <InvitesPanel />
            </div>
          </div>
        )}
      />
    </SectionPage>
  );
}
