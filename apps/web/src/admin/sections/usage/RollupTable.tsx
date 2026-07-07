/**
 * The Usage & Spend rollup table: columns for whichever groupBy dimensions
 * are selected, plus the fixed numeric columns, plus a per-column totals
 * footer. Money follows the PerfPanel cost-truth convention exactly (see
 * ../../lib/format.ts's file header).
 */
import type { UsageRollupRow } from "@wizz/contracts";
import type { AdminUsageGroupBy } from "../../../services/gateway";
import { fmtCompactNumber, fmtCostCell, fmtDurationHM } from "../../lib/format";
import { sumUsageRollup } from "../../lib/usage-rollup";

function dimCell(row: UsageRollupRow, dim: AdminUsageGroupBy): string {
  switch (dim) {
    case "day":
      return row.day ?? "—";
    case "user":
      return row.email ?? row.userId ?? "—";
    case "provider":
      return row.provider ?? "—";
    case "model":
      return row.model ?? "—";
    case "category":
      return row.category ?? "—";
  }
}

export function RollupTable({ rows, groupBy }: { rows: UsageRollupRow[]; groupBy: AdminUsageGroupBy[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">No usage in this window.</p>;
  }

  const totals = sumUsageRollup(rows);
  const totalsCost = fmtCostCell(totals.knownCostUSD, totals.costedEvents, totals.events);
  const hasDims = groupBy.length > 0;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-background-secondary text-left text-text-secondary">
            {hasDims ? (
              groupBy.map((dim) => (
                <th key={dim} className="px-2 py-1.5 font-normal">
                  {dim}
                </th>
              ))
            ) : (
              <th className="px-2 py-1.5 font-normal">(all)</th>
            )}
            <th className="px-2 py-1.5 text-right font-normal">events</th>
            <th className="px-2 py-1.5 text-right font-normal">prompt</th>
            <th className="px-2 py-1.5 text-right font-normal">completion</th>
            <th className="px-2 py-1.5 text-right font-normal">cached</th>
            <th className="px-2 py-1.5 text-right font-normal">frames</th>
            <th className="px-2 py-1.5 text-right font-normal">seconds</th>
            <th className="px-2 py-1.5 text-right font-normal">units</th>
            <th className="px-2 py-1.5 text-right font-normal">known $</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const cost = fmtCostCell(row.knownCostUSD, row.costedEvents, row.events);
            return (
              // Array index as key: rows have no stable natural key across arbitrary groupBy combos
              // (this project's eslint config has no react/no-array-index-key rule to satisfy).
              <tr key={i} className="border-b border-border last:border-b-0">
                {hasDims ? (
                  groupBy.map((dim) => (
                    <td key={dim} className="px-2 py-1.5 text-text-primary">
                      {dimCell(row, dim)}
                    </td>
                  ))
                ) : (
                  <td className="px-2 py-1.5 text-text-primary">(all)</td>
                )}
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">{row.events}</td>
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">
                  {fmtCompactNumber(row.promptTokens)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">
                  {fmtCompactNumber(row.completionTokens)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">
                  {fmtCompactNumber(row.cachedTokens)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">
                  {fmtCompactNumber(row.frames)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">
                  {fmtDurationHM(row.seconds)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-text-secondary">{row.units}</td>
                <td className="px-2 py-1.5 text-right font-mono text-text-primary" title={cost.title}>
                  {cost.text}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-background-secondary font-semibold">
            {hasDims ? (
              groupBy.map((dim, i) => (
                <td key={dim} className="px-2 py-1.5 text-text-primary">
                  {i === 0 ? "total" : ""}
                </td>
              ))
            ) : (
              <td className="px-2 py-1.5 text-text-primary">total</td>
            )}
            <td className="px-2 py-1.5 text-right font-mono text-text-primary">{totals.events}</td>
            <td className="px-2 py-1.5 text-right font-mono text-text-primary">
              {fmtCompactNumber(totals.promptTokens)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-text-primary">
              {fmtCompactNumber(totals.completionTokens)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-text-primary">
              {fmtCompactNumber(totals.cachedTokens)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-text-primary">
              {fmtCompactNumber(totals.frames)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-text-primary">{fmtDurationHM(totals.seconds)}</td>
            <td className="px-2 py-1.5 text-right font-mono text-text-primary">{totals.units}</td>
            <td className="px-2 py-1.5 text-right font-mono text-text-primary" title={totalsCost.title}>
              {totalsCost.text}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
