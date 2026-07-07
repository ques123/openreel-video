/**
 * Selected-user detail: recent UsageEvents, the quota-override editor,
 * disable/enable, and reset-password. Every mutation is optimistic-free —
 * call, then refetch both this panel (`load`) and the parent list
 * (`onChanged`) so the table's usage/status columns stay truthful too.
 */
import { useCallback, useEffect, useState } from "react";
import type { AdminUserSummary, QuotaLimits, UsageEvent } from "@wizz/contracts";
import { adminGetUser, adminPatchUser, adminResetPassword } from "../../../services/gateway";
import { ConfirmButton } from "../../../pages/lab/components/ConfirmButton";
import { AdminProbeResult, describeProbeError, type ProbeState } from "../../AdminProbeResult";
import { CopyableCode } from "../../components/CopyableCode";
import { fmtDateTime, fmtKnownCostUSD } from "../../lib/format";
import { buildQuotaOverridesPatch, draftFromOverrides, type QuotaOverrideDraft } from "../../lib/quota-drafts";
import { QuotaOverridesEditor } from "./QuotaOverridesEditor";

type Detail = { user: AdminUserSummary; recent: UsageEvent[] };

function fmtUsageEventAmount(e: UsageEvent): string {
  switch (e.category) {
    case "director": {
      const tok = (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
      return `${tok.toLocaleString("en-US")} tok`;
    }
    case "caption":
      return `${e.frames ?? 0} frames`;
    case "stt":
      return `${(e.seconds ?? 0).toFixed(0)}s`;
    case "music":
      return `${e.units ?? 0} gen`;
    default:
      return "—";
  }
}

function StatusBadge({ status }: { status: number }) {
  const bad = status === 0 || status >= 400;
  return (
    <span className={bad ? "font-mono text-status-error" : "font-mono text-text-secondary"}>
      {status === 0 ? "no response" : status}
    </span>
  );
}

export function UserDetailPanel({
  userId,
  onClose,
  onChanged,
}: {
  userId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ProbeState<Detail>>({ status: "loading" });
  const [overrideDraft, setOverrideDraft] = useState<QuotaOverrideDraft | null>(null);
  const [savingOverrides, setSavingOverrides] = useState(false);
  const [overridesError, setOverridesError] = useState<unknown>(null);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<unknown>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<unknown>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const load = useCallback(() => {
    setDetail((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    return adminGetUser(userId)
      .then((data) => {
        setDetail({ status: "ok", data });
        setOverrideDraft(draftFromOverrides(data.user.quotaOverrides));
      })
      .catch((error: unknown) => setDetail({ status: "error", error }));
  }, [userId]);

  useEffect(() => {
    setTempPassword(null); // switching users must never keep showing a stale temp password
    setOverridesError(null);
    setDisableError(null);
    setResetError(null);
    void load();
  }, [userId, load]);

  const baseline = detail.status === "ok" ? detail.data.user.quotaOverrides : null;
  const pendingPatch =
    overrideDraft && detail.status === "ok" ? buildQuotaOverridesPatch(baseline, overrideDraft) : undefined;

  const applyQuotaOverrides = (patch: Partial<QuotaLimits> | null) => {
    setSavingOverrides(true);
    setOverridesError(null);
    adminPatchUser(userId, { quotaOverrides: patch })
      .then(() => {
        onChanged();
        return load();
      })
      .catch((error: unknown) => setOverridesError(error))
      .finally(() => setSavingOverrides(false));
  };

  const toggleDisabled = (nextDisabled: boolean) => {
    setDisabling(true);
    setDisableError(null);
    adminPatchUser(userId, { disabled: nextDisabled })
      .then(() => {
        onChanged();
        return load();
      })
      .catch((error: unknown) => setDisableError(error))
      .finally(() => setDisabling(false));
  };

  const resetPassword = () => {
    setResetting(true);
    setResetError(null);
    setTempPassword(null);
    adminResetPassword(userId)
      .then(({ tempPassword: pw }) => setTempPassword(pw))
      .catch((error: unknown) => setResetError(error))
      .finally(() => setResetting(false));
  };

  return (
    <div className="rounded-md border border-border bg-background-secondary p-4">
      <div className="mb-3 flex items-start justify-between">
        <h2 className="text-sm font-semibold text-text-primary">User detail</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-text-secondary hover:text-text-primary"
        >
          close ✕
        </button>
      </div>

      <AdminProbeResult
        state={detail}
        render={({ user, recent }) => (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt className="text-text-secondary">email</dt>
              <dd className="text-text-primary">{user.email}</dd>
              <dt className="text-text-secondary">id</dt>
              <dd className="text-text-primary">{user.id}</dd>
              <dt className="text-text-secondary">created</dt>
              <dd className="text-text-primary">{fmtDateTime(user.createdAt)}</dd>
              <dt className="text-text-secondary">last seen</dt>
              <dd className="text-text-primary">{fmtDateTime(user.lastSeenAt)}</dd>
              <dt className="text-text-secondary">invite</dt>
              <dd className="text-text-primary">{user.inviteId ?? "—"}</dd>
            </dl>

            <div>
              <div className="mb-1 flex items-center gap-2">
                <ConfirmButton
                  onConfirm={() => toggleDisabled(!user.disabled)}
                  disabled={disabling}
                  className={
                    "rounded border px-2 py-1 text-xs disabled:opacity-40 " +
                    (user.disabled
                      ? "border-border text-text-secondary hover:text-text-primary"
                      : "border-status-error/40 text-status-error hover:bg-status-error/10")
                  }
                  armedClassName="bg-status-error/10"
                  confirmLabel="sure? click again"
                >
                  {disabling ? "working…" : user.disabled ? "Enable user" : "Disable user"}
                </ConfirmButton>
                <ConfirmButton
                  onConfirm={resetPassword}
                  disabled={resetting}
                  className="rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                  confirmLabel="sure? click again"
                >
                  {resetting ? "resetting…" : "Reset password"}
                </ConfirmButton>
              </div>
              {disableError !== null && (
                <p className="text-xs text-status-error">{describeProbeError(disableError)}</p>
              )}
              {resetError !== null && <p className="text-xs text-status-error">{describeProbeError(resetError)}</p>}
              {tempPassword && (
                <div className="mt-1.5 max-w-sm">
                  <CopyableCode
                    value={tempPassword}
                    warning="Shown once — copy it now. The gateway never stores or returns it again."
                  />
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-1 text-xs font-semibold text-text-primary">Quota overrides</h3>
              {overrideDraft && (
                <>
                  <QuotaOverridesEditor draft={overrideDraft} onChange={setOverrideDraft} disabled={savingOverrides} />
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => pendingPatch !== undefined && applyQuotaOverrides(pendingPatch)}
                      disabled={savingOverrides || pendingPatch === undefined}
                      className="rounded bg-primary px-2 py-1 text-xs text-white disabled:opacity-40"
                    >
                      {savingOverrides ? "saving…" : "Save overrides"}
                    </button>
                    <ConfirmButton
                      onConfirm={() => applyQuotaOverrides(null)}
                      disabled={savingOverrides || (baseline === null && pendingPatch === undefined)}
                      className="rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                      confirmLabel="sure? click again"
                    >
                      Clear all overrides
                    </ConfirmButton>
                  </div>
                  {overridesError !== null && (
                    <p className="mt-1 text-xs text-status-error">{describeProbeError(overridesError)}</p>
                  )}
                </>
              )}
            </div>

            <div>
              <h3 className="mb-1 text-xs font-semibold text-text-primary">
                Recent events <span className="font-normal text-text-secondary">(last {recent.length})</span>
              </h3>
              {recent.length === 0 ? (
                <p className="text-xs text-text-secondary">No usage events yet.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded border border-border">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-background-secondary">
                      <tr className="border-b border-border text-left text-text-secondary">
                        <th className="px-2 py-1 font-normal">time</th>
                        <th className="px-2 py-1 font-normal">provider</th>
                        <th className="px-2 py-1 font-normal">model</th>
                        <th className="px-2 py-1 text-right font-normal">amount</th>
                        <th className="px-2 py-1 text-right font-normal">$</th>
                        <th className="px-2 py-1 text-right font-normal">status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((e) => (
                        <tr key={e.id} className="border-b border-border last:border-b-0">
                          <td className="px-2 py-1 font-mono text-text-secondary">{fmtDateTime(e.at)}</td>
                          <td className="px-2 py-1 text-text-primary">{e.provider}</td>
                          <td className="px-2 py-1 font-mono text-text-secondary">{e.model ?? "—"}</td>
                          <td className="px-2 py-1 text-right font-mono text-text-primary">
                            {fmtUsageEventAmount(e)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-text-primary">
                            {fmtKnownCostUSD(e.actualCostUSD)}
                          </td>
                          <td className="px-2 py-1 text-right">
                            <StatusBadge status={e.upstreamStatus} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      />
    </div>
  );
}
