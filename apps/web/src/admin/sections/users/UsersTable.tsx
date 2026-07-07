/**
 * The Users list: one row per AdminUserSummary. Row click selects a user for
 * the detail panel below (UsersSection owns the selection state).
 */
import { QUOTA_CATEGORIES, type AdminUserSummary, type QuotaCategory } from "@wizz/contracts";
import { fmtDateTime, fmtExactUSD, fmtQuotaUsageValue } from "../../lib/format";

const SHORT_LABEL: Record<QuotaCategory, string> = {
  directorTokens: "dir",
  sunoGens: "music",
  cloudCaptionFrames: "cap",
  sttSeconds: "stt",
};

/** "dir 1.2k/40.0k · stt 3m/1h 30m" — only categories with any lifetime usage at all, so a fresh user just reads "—". */
function usageSummary(usage: AdminUserSummary["usage"]): string {
  const parts = QUOTA_CATEGORIES.filter((c) => (usage.total[c] ?? 0) > 0).map(
    (c) => `${SHORT_LABEL[c]} ${fmtQuotaUsageValue(c, usage.today[c] ?? 0)}/${fmtQuotaUsageValue(c, usage.total[c] ?? 0)}`,
  );
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export function UsersTable({
  users,
  selectedId,
  onSelect,
}: {
  users: AdminUserSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (users.length === 0) {
    return <p className="text-sm text-text-secondary">No users match this search.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-background-secondary text-left text-text-secondary">
            <th className="px-2 py-1.5 font-normal">email</th>
            <th className="px-2 py-1.5 font-normal">created</th>
            <th className="px-2 py-1.5 font-normal">last seen</th>
            <th className="px-2 py-1.5 font-normal">status</th>
            <th className="px-2 py-1.5 font-normal">usage (today/total)</th>
            <th className="px-2 py-1.5 text-right font-normal" title="Σ actualCostUSD where reported — a floor, not the full bill">
              known $ (floor)
            </th>
            <th className="px-2 py-1.5 text-right font-normal">events</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const selected = u.id === selectedId;
            return (
              <tr
                key={u.id}
                onClick={() => onSelect(u.id)}
                className={
                  "cursor-pointer border-b border-border last:border-b-0 " +
                  (selected ? "bg-background-tertiary" : "hover:bg-background-secondary")
                }
              >
                <td className="px-2 py-1.5 text-text-primary">{u.email}</td>
                <td className="px-2 py-1.5 font-mono text-text-secondary">{fmtDateTime(u.createdAt)}</td>
                <td className="px-2 py-1.5 font-mono text-text-secondary">{fmtDateTime(u.lastSeenAt)}</td>
                <td className="px-2 py-1.5">
                  {u.disabled ? (
                    <span className="rounded bg-status-error/15 px-1.5 py-0.5 text-[10px] font-medium text-status-error">
                      disabled
                    </span>
                  ) : (
                    <span className="text-[10px] text-text-secondary/70">active</span>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-text-secondary">
                  {usageSummary(u.usage)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-text-primary">
                  {fmtExactUSD(u.usage.knownCostUSD)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">{u.usage.events}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
