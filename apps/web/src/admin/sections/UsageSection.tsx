/**
 * Usage & Spend: groupBy chips + date window + rollup table (PerfPanel
 * exact-$ conventions), plus a "spend today / this week" stat row. See
 * docs/wizz-video-plan.md §WS-C and docs/wizz-contracts.md §2.
 */
import { useEffect, useState } from "react";
import type { UsageRollupRow } from "@wizz/contracts";
import { adminGetUsage, type AdminUsageGroupBy } from "../../services/gateway";
import { AdminProbeResult, describeProbeError, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";
import { fmtExactUSD } from "../lib/format";
import {
  estimateRollupSpendUSD,
  resolveDateRangePreset,
  startOfIsoWeekYMD,
  sumUsageRollup,
  toggleUsageGroupBy,
  type DateRangePreset,
} from "../lib/usage-rollup";
import { DateWindowPicker } from "./usage/DateWindowPicker";
import { GroupByChips } from "./usage/GroupByChips";
import { RollupTable } from "./usage/RollupTable";

function StatTile({ label, state }: { label: string; state: ProbeState<{ rows: UsageRollupRow[] }> }) {
  return (
    <div className="rounded-md border border-border bg-background-secondary p-3">
      <p className="text-[11px] uppercase tracking-wide text-text-secondary">{label}</p>
      {state.status === "loading" && <p className="mt-1 text-lg text-text-secondary">…</p>}
      {state.status === "error" && (
        <p className="mt-1 text-xs text-status-error">{describeProbeError(state.error)}</p>
      )}
      {state.status === "ok" &&
        (() => {
          const totals = sumUsageRollup(state.data.rows);
          const spend = estimateRollupSpendUSD(state.data.rows);
          // Estimated = provider-billed where reported (OpenRouter/Groq) +
          // token×list-price for OpenAI director/caption (which never report a
          // cost — token×rate IS the invoice). The old exact-only sum showed
          // near-$0 because it counted only the STT slice.
          const title =
            "estimated spend: exact provider bills where reported, plus token×list-price for OpenAI" +
            (spend.unpriceableEvents > 0 ? ` (${spend.unpriceableEvents} events not priceable, e.g. Suno)` : "");
          return (
            <>
              <p className="mt-1 font-mono text-lg text-text-primary" title={title}>
                {spend.hasEstimate ? "≈" : ""}
                {fmtExactUSD(spend.totalUSD)}
              </p>
              <p className="text-[11px] text-text-secondary">{totals.events} events</p>
            </>
          );
        })()}
    </div>
  );
}

export function UsageSection() {
  const [groupBy, setGroupBy] = useState<AdminUsageGroupBy[]>(["day"]);
  const [preset, setPreset] = useState<DateRangePreset>("30d");
  const [custom, setCustom] = useState(() => resolveDateRangePreset("today", new Date()));
  const [rowsState, setRowsState] = useState<ProbeState<{ rows: UsageRollupRow[] }>>({ status: "loading" });
  const [todayState, setTodayState] = useState<ProbeState<{ rows: UsageRollupRow[] }>>({ status: "loading" });
  const [weekState, setWeekState] = useState<ProbeState<{ rows: UsageRollupRow[] }>>({ status: "loading" });

  const range = resolveDateRangePreset(preset, new Date(), custom);
  const rangeReady = preset !== "custom" || Boolean(custom.from && custom.to);

  useEffect(() => {
    if (!rangeReady) return;
    let cancelled = false;
    setRowsState((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    adminGetUsage({ groupBy, from: range.from, to: range.to })
      .then((data) => {
        if (!cancelled) setRowsState({ status: "ok", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setRowsState({ status: "error", error });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy.join(","), range.from, range.to, rangeReady]);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const todayYMD = now.toISOString().slice(0, 10);
    // Group by model+provider so each row carries a single model — required
    // for the token×rate estimate that dollarizes OpenAI director spend.
    const spendGroupBy: AdminUsageGroupBy[] = ["provider", "model"];
    adminGetUsage({ groupBy: spendGroupBy, from: todayYMD, to: todayYMD })
      .then((data) => {
        if (!cancelled) setTodayState({ status: "ok", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setTodayState({ status: "error", error });
      });
    adminGetUsage({ groupBy: spendGroupBy, from: startOfIsoWeekYMD(now), to: todayYMD })
      .then((data) => {
        if (!cancelled) setWeekState({ status: "ok", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setWeekState({ status: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SectionPage
      title="Usage & Spend"
      wide
      description="Rollups by day/user/provider/model/category, with exact-$ where providers report it."
    >
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-2 md:w-96">
        <StatTile label="Spend today" state={todayState} />
        <StatTile label="Spend this week" state={weekState} />
      </div>

      <div className="mb-3 space-y-2">
        <GroupByChips selected={groupBy} onToggle={(dim) => setGroupBy((prev) => toggleUsageGroupBy(prev, dim))} />
        <DateWindowPicker preset={preset} onPresetChange={setPreset} custom={custom} onCustomChange={setCustom} />
      </div>

      <AdminProbeResult state={rowsState} render={(data) => <RollupTable rows={data.rows} groupBy={groupBy} />} />
    </SectionPage>
  );
}
