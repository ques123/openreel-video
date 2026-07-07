/**
 * Pure helpers for the Usage & Spend section: the groupBy chip row, the
 * date-window presets, and the rollup table's per-column totals footer.
 */
import type { UsageRollupRow } from "@wizz/contracts";
import type { AdminUsageGroupBy } from "../../services/gateway";
import { estimateCostUSD } from "../../services/model-pricing";

/** Canonical, stable chip order — also the column order in the rollup table. */
export const USAGE_GROUP_BY_DIMENSIONS: readonly AdminUsageGroupBy[] = [
  "day",
  "user",
  "provider",
  "model",
  "category",
];

/**
 * Toggling a chip always returns dimensions in the CANONICAL order above,
 * regardless of click order, so the rollup table's column order (and its
 * SQL GROUP BY/ORDER BY on the server) is deterministic no matter which chip
 * the admin happened to click last.
 */
export function toggleUsageGroupBy(
  selected: readonly AdminUsageGroupBy[],
  dim: AdminUsageGroupBy,
): AdminUsageGroupBy[] {
  const set = new Set(selected);
  if (set.has(dim)) set.delete(dim);
  else set.add(dim);
  return USAGE_GROUP_BY_DIMENSIONS.filter((d) => set.has(d));
}

/* ───────────────────── date-window presets ───────────────────── */

export type DateRangePreset = "today" | "7d" | "30d" | "custom";

export interface DateRangeYMD {
  /** UTC "YYYY-MM-DD", inclusive (contracts §2). */
  from: string;
  to: string;
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves a preset (today/7d/30d/custom) against `now` (injectable for
 * tests) into the server's inclusive UTC YYYY-MM-DD from/to. "7d"/"30d" are
 * trailing windows INCLUDING today (7d = today minus 6 days .. today).
 * "custom" passes the caller's own from/to through unchanged (falling back
 * to a single-day "today" window if none was supplied yet).
 */
export function resolveDateRangePreset(
  preset: DateRangePreset,
  now: Date,
  custom?: { from: string; to: string },
): DateRangeYMD {
  const to = toYMD(now);
  if (preset === "today") return { from: to, to };
  if (preset === "7d") return { from: toYMD(new Date(now.getTime() - 6 * DAY_MS)), to };
  if (preset === "30d") return { from: toYMD(new Date(now.getTime() - 29 * DAY_MS)), to };
  return custom ?? { from: to, to };
}

/**
 * The UTC Monday of the ISO week containing `now` — the "this week" spend
 * stat's start bound. Deliberately distinct from the rolling "7d" table
 * preset above: "this week" is calendar-week-to-date, "7d" is a trailing
 * window, and showing both side by side is more informative than either
 * alone.
 */
export function startOfIsoWeekYMD(now: Date): string {
  const day = now.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const diffToMonday = day === 0 ? 6 : day - 1;
  return toYMD(new Date(now.getTime() - diffToMonday * DAY_MS));
}

/* ───────────────────── totals footer ───────────────────── */

export interface UsageRollupTotals {
  events: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  frames: number;
  seconds: number;
  units: number;
  /** Sum of knownCostUSD over rows that reported one; null when NOT ONE row in the result set ever did. */
  knownCostUSD: number | null;
  costedEvents: number;
}

/**
 * Per-column totals footer. Mirrors the row-level cost-truth rule at the
 * aggregate level: any row with a known cost contributes it to the sum; the
 * total is null only when nothing in the whole result set ever reported one
 * (never silently "$0.00").
 */
export function sumUsageRollup(rows: readonly UsageRollupRow[]): UsageRollupTotals {
  const totals: UsageRollupTotals = {
    events: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    frames: 0,
    seconds: 0,
    units: 0,
    knownCostUSD: null,
    costedEvents: 0,
  };
  let sumCost = 0;
  let anyCosted = false;
  for (const row of rows) {
    totals.events += row.events;
    totals.promptTokens += row.promptTokens;
    totals.completionTokens += row.completionTokens;
    totals.cachedTokens += row.cachedTokens;
    totals.frames += row.frames;
    totals.seconds += row.seconds;
    totals.units += row.units;
    totals.costedEvents += row.costedEvents;
    if (row.knownCostUSD !== null) {
      sumCost += row.knownCostUSD;
      anyCosted = true;
    }
  }
  totals.knownCostUSD = anyCosted ? sumCost : null;
  return totals;
}

/* ───────────────────── estimated spend ───────────────────── */

/**
 * Best-effort USD for ONE rollup row. `knownCostUSD` (provider-billed:
 * OpenRouter usage.cost, Groq billed seconds) is used when every event in the
 * row reported one. Otherwise, when the row is grouped down to a single known
 * model (OpenAI director/caption never report a cost — token×rate IS the
 * invoice), we estimate from tokens via model-pricing (cached tokens get the
 * discount). null when neither applies (e.g. Suno units, or a mixed-model row
 * with no cost) — so the caller can count it as unpriceable rather than $0.
 */
export function estimatedRowCostUSD(row: UsageRollupRow): number | null {
  if (row.knownCostUSD !== null && row.costedEvents === row.events) return row.knownCostUSD;
  if (row.model) {
    const est = estimateCostUSD(row.model, row.promptTokens, row.completionTokens, row.cachedTokens);
    if (est !== null) return est;
  }
  return row.knownCostUSD; // partial exact-$ (or null) when tokens can't be priced
}

export interface EstimatedSpend {
  /** Σ of priceable rows (exact where billed, token estimate otherwise). */
  totalUSD: number;
  /** How many events sit in rows we could NOT price at all (e.g. Suno). */
  unpriceableEvents: number;
  /** True when any row's figure came from a token estimate rather than a provider bill. */
  hasEstimate: boolean;
}

/**
 * Aggregate estimated spend across a rollup. Give it rows grouped so each
 * carries a single model (e.g. groupBy includes "model") — otherwise
 * multi-model rows can't be token-priced and land in `unpriceableEvents`.
 * This is what makes the admin's "spend today" reflect director cost instead
 * of the STT-only slice the raw provider-billed sum would show.
 */
export function estimateRollupSpendUSD(rows: readonly UsageRollupRow[]): EstimatedSpend {
  let totalUSD = 0;
  let unpriceableEvents = 0;
  let hasEstimate = false;
  for (const row of rows) {
    const exact = row.knownCostUSD !== null && row.costedEvents === row.events;
    const cost = estimatedRowCostUSD(row);
    if (cost === null) {
      unpriceableEvents += row.events;
      continue;
    }
    totalUSD += cost;
    if (!exact) hasEstimate = true;
  }
  return { totalUSD, unpriceableEvents, hasEstimate };
}
