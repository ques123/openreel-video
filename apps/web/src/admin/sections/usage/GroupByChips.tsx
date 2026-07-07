/**
 * The groupBy multi-select chip row — maps straight to the server's
 * comma-joined `groupBy` param (adminGetUsage). Chip order is fixed
 * (USAGE_GROUP_BY_DIMENSIONS) regardless of click order, so the resulting
 * table's columns are always in the same, predictable order.
 */
import type { AdminUsageGroupBy } from "../../../services/gateway";
import { USAGE_GROUP_BY_DIMENSIONS } from "../../lib/usage-rollup";

const DIM_LABEL: Record<AdminUsageGroupBy, string> = {
  day: "day",
  user: "user",
  provider: "provider",
  model: "model",
  category: "category",
};

export function GroupByChips({
  selected,
  onToggle,
}: {
  selected: readonly AdminUsageGroupBy[];
  onToggle: (dim: AdminUsageGroupBy) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {USAGE_GROUP_BY_DIMENSIONS.map((dim) => {
        const active = selected.includes(dim);
        return (
          <button
            key={dim}
            type="button"
            onClick={() => onToggle(dim)}
            className={
              "rounded-full border px-2.5 py-1 text-xs " +
              (active
                ? "border-primary bg-primary/10 text-text-primary"
                : "border-border text-text-secondary hover:text-text-primary")
            }
          >
            {DIM_LABEL[dim]}
          </button>
        );
      })}
    </div>
  );
}
