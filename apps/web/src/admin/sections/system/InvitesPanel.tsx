/**
 * Invite codes: mint form + list table with per-row disable. Codes stay
 * visible in the list forever (unlike a reset temp password, they're never
 * hashed away) so the just-minted result doesn't need a "shown once"
 * warning — CopyableCode is used here purely as a convenience.
 */
import { useEffect, useState } from "react";
import type { InviteCode } from "@wizz/contracts";
import { adminCreateInvite, adminListInvites, adminPatchInvite } from "../../../services/gateway";
import { ConfirmButton } from "../../../pages/lab/components/ConfirmButton";
import { AdminProbeResult, describeProbeError, type ProbeState } from "../../AdminProbeResult";
import { CopyableCode } from "../../components/CopyableCode";
import { fmtDateTime } from "../../lib/format";

export function InvitesPanel() {
  const [state, setState] = useState<ProbeState<{ invites: InviteCode[] }>>({ status: "loading" });
  const [maxUses, setMaxUses] = useState(1);
  const [expiresAt, setExpiresAt] = useState(""); // datetime-local string, empty = no expiry
  const [note, setNote] = useState("");
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<unknown>(null);
  const [justCreated, setJustCreated] = useState<InviteCode | null>(null);
  const [disablingId, setDisablingId] = useState<string | null>(null);
  const [disableError, setDisableError] = useState<unknown>(null);

  const load = () => {
    setState((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    adminListInvites()
      .then((data) => setState({ status: "ok", data }))
      .catch((error: unknown) => setState({ status: "error", error }));
  };

  useEffect(load, []);

  const mint = () => {
    setMinting(true);
    setMintError(null);
    adminCreateInvite({
      maxUses,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      note: note.trim() || null,
    })
      .then(({ invite }) => {
        setJustCreated(invite);
        setNote("");
        load();
      })
      .catch((error: unknown) => setMintError(error))
      .finally(() => setMinting(false));
  };

  const disable = (id: string) => {
    setDisablingId(id);
    setDisableError(null);
    adminPatchInvite(id, { disabled: true })
      .then(() => load())
      .catch((error: unknown) => setDisableError(error))
      .finally(() => setDisablingId(null));
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-text-secondary">
          max uses
          <input
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (!Number.isNaN(v)) setMaxUses(Math.max(1, Math.round(v)));
            }}
            className="mt-0.5 block w-20 rounded border border-border bg-background px-1.5 py-1 text-text-primary outline-none focus:border-primary"
          />
        </label>
        <label className="text-xs text-text-secondary">
          expiry <span className="text-text-secondary/60">(optional)</span>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="mt-0.5 block rounded border border-border bg-background px-1.5 py-1 text-text-primary outline-none focus:border-primary"
          />
        </label>
        <label className="flex-1 text-xs text-text-secondary">
          note <span className="text-text-secondary/60">(optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="launch batch #1"
            className="mt-0.5 block w-full rounded border border-border bg-background px-1.5 py-1 text-text-primary outline-none focus:border-primary"
          />
        </label>
        <button
          type="button"
          onClick={mint}
          disabled={minting}
          className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {minting ? "minting…" : "Mint invite"}
        </button>
      </div>
      {mintError !== null && <p className="mb-2 text-xs text-status-error">{describeProbeError(mintError)}</p>}
      {justCreated && (
        <div className="mb-3 max-w-sm">
          <CopyableCode value={justCreated.code} />
        </div>
      )}

      <AdminProbeResult
        state={state}
        render={(data) => {
          if (data.invites.length === 0) {
            return <p className="text-sm text-text-secondary">No invites minted yet.</p>;
          }
          return (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-background-secondary text-left text-text-secondary">
                    <th className="px-2 py-1.5 font-normal">code</th>
                    <th className="px-2 py-1.5 font-normal">uses</th>
                    <th className="px-2 py-1.5 font-normal">expiry</th>
                    <th className="px-2 py-1.5 font-normal">note</th>
                    <th className="px-2 py-1.5 font-normal">status</th>
                    <th className="px-2 py-1.5 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {data.invites.map((inv) => (
                    <tr key={inv.id} className="border-b border-border last:border-b-0">
                      <td className="px-2 py-1.5 font-mono text-text-primary">{inv.code}</td>
                      <td className="px-2 py-1.5 font-mono text-text-secondary">
                        {inv.usedCount}/{inv.maxUses}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-text-secondary">
                        {inv.expiresAt ? fmtDateTime(inv.expiresAt) : "never"}
                      </td>
                      <td className="px-2 py-1.5 text-text-secondary">{inv.note ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        {inv.disabled ? (
                          <span className="rounded bg-status-error/15 px-1.5 py-0.5 text-[10px] font-medium text-status-error">
                            disabled
                          </span>
                        ) : (
                          <span className="text-[10px] text-text-secondary/70">active</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {!inv.disabled && (
                          <ConfirmButton
                            onConfirm={() => disable(inv.id)}
                            disabled={disablingId === inv.id}
                            className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:text-status-error disabled:opacity-40"
                            confirmLabel="sure?"
                          >
                            disable
                          </ConfirmButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {disableError !== null && (
                <p className="border-t border-border px-2 py-1.5 text-xs text-status-error">
                  {describeProbeError(disableError)}
                </p>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
