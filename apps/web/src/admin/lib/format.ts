/**
 * Admin-surface formatting helpers. These deliberately mirror the lab's
 * cost-truth conventions (pages/lab/components/PerfPanel.tsx: fmtExactUSD,
 * the never-"$0.00"-for-unknown rule) rather than import them — PerfPanel's
 * helpers are module-private (not exported), and the admin's shapes differ
 * slightly (server-computed UsageRollupRow/AdminUserSummary vs the lab's
 * client-side cloudRunArchive) — so these are independent re-implementations
 * of the SAME rules, per docs/wizz-video-plan.md §WS-C:
 *
 *   - a known cost is either an EXACT dollar figure (never a "~" estimate —
 *     the gateway only ever records actualCostUSD when a provider reports
 *     billing verbatim: OpenRouter usage.cost, or Groq seconds × flat rate)
 *     or genuinely unknown; unknown renders "—", NEVER "$0.00" (that would
 *     claim "free" when the truth is "not measured").
 *   - an aggregated cost is shown beside how much of the underlying event
 *     count it's actually known for ("$0.0182 · 3/5 costed") so partial
 *     knowledge is never silently presented as complete.
 *   - AdminUserSummary.usage.knownCostUSD is the ONE exception: contracts.ts
 *     types it as a plain `number` (not nullable) and documents it as
 *     "a floor, not the bill" — the server already coalesces unknown-to-0
 *     for that lifetime rollup, so it renders as a plain dollar figure
 *     (never "—") with a tooltip clarifying it's a floor, not the honesty-
 *     null convention used everywhere else.
 */
import type { QuotaCategory } from "@wizz/contracts";

/** Exact 4-decimal dollar figure — never a tilde estimate (see file header). */
export function fmtExactUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** `knownCostUSD === null` (UsageRollupRow, totals) -> "—", never "$0.00". */
export function fmtKnownCostUSD(knownCostUSD: number | null): string {
  return knownCostUSD === null ? "—" : fmtExactUSD(knownCostUSD);
}

export interface CostCellText {
  text: string;
  /** Tooltip explaining the honesty rule, for a `title` attribute. */
  title: string;
}

/**
 * The exact "$0.0182 · 3/5 costed" cell convention for an aggregated row
 * (UsageRollupRow or a totals footer): no events at all renders a bare "—"
 * (nothing to be honest about); events with zero known cost renders
 * "— · 0/N costed" (activity happened, cost just wasn't reported — more
 * honest than a bare dash, which could be misread as "no activity"); any
 * known cost renders the dollar figure plus the fraction.
 */
export function fmtCostCell(knownCostUSD: number | null, costedEvents: number, events: number): CostCellText {
  if (events <= 0) return { text: "—", title: "no events in this row" };
  if (knownCostUSD === null) {
    return {
      text: `— · 0/${events} costed`,
      title: "none of these events reported an exact billed cost",
    };
  }
  return {
    text: `${fmtExactUSD(knownCostUSD)} · ${costedEvents}/${events} costed`,
    title: "sum of exactly-known costs; the fraction is how many events reported one",
  };
}

/** 1234 -> "1.2k", 950 -> "950" — compact counts for token/frame/unit columns. */
export function fmtCompactNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** 45 -> "<1m", 185 -> "3m", 5410 -> "1h 30m" — seconds at a glance (STT billed seconds, uptime). */
export function fmtDurationHM(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0m";
  if (totalSeconds < 60) return "<1m";
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

/** 5_400_000_000 -> "5.4GB", 800_000 -> "800.0MB" — DB size at a glance. */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** null = unlimited (first-class per @wizz/contracts QuotaLimits) -> "unlimited"; else a comma-grouped integer. */
export function fmtQuotaLimit(limit: number | null): string {
  return limit === null ? "unlimited" : Math.round(limit).toLocaleString("en-US");
}

const QUOTA_CATEGORY_LABELS: Record<QuotaCategory, string> = {
  directorTokens: "Director tokens / day",
  sunoGens: "Suno generations / day",
  cloudCaptionFrames: "Cloud caption frames / day",
  sttSeconds: "STT seconds / day",
};

export function quotaCategoryLabel(category: QuotaCategory): string {
  return QUOTA_CATEGORY_LABELS[category];
}

/** The unit a category's raw usage number is in — for compact per-category usage cells. */
export function fmtQuotaUsageValue(category: QuotaCategory, n: number): string {
  if (category === "sttSeconds") return fmtDurationHM(n);
  if (category === "sunoGens") return String(Math.round(n));
  return fmtCompactNumber(n);
}

/** ISO -> "2026-07-07 14:32" (UTC, stable/sortable-looking for admin tables); null/invalid -> "—". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16);
}

/** ISO -> "2026-07-07" (UTC date only); null/invalid -> "—". */
export function fmtDateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
