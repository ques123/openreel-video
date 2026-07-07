/**
 * Wave-2 stub: the real Users list/detail/quota-override editor lands here
 * (see docs/wizz-video-plan.md §WS-C). For now this proves the gateway
 * plumbing end-to-end with one real call — see AdminProbeResult/SectionPage.
 */
import { useEffect, useState } from "react";
import type { AdminUserSummary } from "@wizz/contracts";
import { adminListUsers } from "../../services/gateway";
import { AdminProbeResult, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";

export function UsersSection() {
  const [state, setState] = useState<ProbeState<{ users: AdminUserSummary[] }>>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    adminListUsers()
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
      title="Users"
      description={
        <>
          Wave-2 stub — the real list, per-user usage, and quota-override editor land
          here. This already calls <code className="font-mono">GET /api/admin/users</code>{" "}
          through the gateway service layer.
        </>
      }
    >
      <AdminProbeResult
        state={state}
        render={(data) => (
          <p className="font-mono text-sm text-text-primary">
            {data.users.length} user(s) returned by the gateway.
          </p>
        )}
      />
    </SectionPage>
  );
}
