/**
 * Pure display-formatting helpers for the wizz.video public product. Kept
 * dependency-free and side-effect-free so they're trivially unit-testable —
 * every scene component imports from here rather than hand-rolling copy.
 */
import type { QuotaCategory } from "@wizz/contracts";

/** "4:12", "0:47" — clip/segment/film durations (M:SS, no zero-padded minutes). */
export function fmtDurationShort(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

/** "00:58" / "01:04" — render-overlay progress clock (MM:SS, zero-padded). */
export function fmtClockMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

/** "00:00:58" — screening-room player OSD (HH:MM:SS, zero-padded). */
export function fmtClockHHMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

/** "about 9 minutes left" / "about 1 minute left" — the bench's honest ETA. */
export function fmtEtaLeft(etaS: number): string {
  const mins = Math.max(1, Math.round(etaS / 60));
  return `about ${mins} minute${mins === 1 ? "" : "s"} left`;
}

/** "Understanding your footage — clip 3 of 12". */
export function fmtBatchLine(currentIndex: number, total: number): string {
  return `Understanding your footage — clip ${Math.min(currentIndex + 1, total)} of ${total}`;
}

/**
 * "today" / "yesterday" / "Tuesday" (this week) / "Jun 12" (older) — the
 * relative day naming the studio-return offer card's "Reload Tuesday's
 * footage?" line is built from. Compares calendar days in the LOCAL
 * timezone, not a rolling 24h window (a save at 11pm and a return at 8am the
 * next calendar day should read "yesterday", not "today").
 */
export function relativeDayLabel(savedAtMs: number, nowMs: number = Date.now()): string {
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const dayMs = 86_400_000;
  const diffDays = Math.round((startOfDay(nowMs) - startOfDay(savedAtMs)) / dayMs);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return new Date(savedAtMs).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(savedAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Tuesday's footage" / "today's footage" — the offer card's headline noun phrase. */
export function restoreOfferLabel(savedAtMs: number, nowMs: number = Date.now()): string {
  return `${relativeDayLabel(savedAtMs, nowMs)}'s footage`;
}

/** "30s" / "90s" / "3 min" — length-chip labels (the wireframe's exact strings for its default chip seconds). */
export function fmtChipLabel(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** "Resets in about 3 hours." — capitalizes the first letter of a sentence-initial fragment. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "12 clips · 38 minutes" — the offer card's hint line. */
export function fmtClipsSummary(clipCount: number, totalSeconds: number | null): string {
  const clipsPart = `${clipCount} clip${clipCount === 1 ? "" : "s"}`;
  if (totalSeconds === null) return clipsPart;
  const mins = Math.max(1, Math.round(totalSeconds / 60));
  return `${clipsPart} · ${mins} minute${mins === 1 ? "" : "s"}`;
}

/** The next UTC-midnight quota reset, ISO — the daily window boundary (contracts §0). */
export function nextUtcMidnightIso(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return new Date(next).toISOString();
}

const QUOTA_CATEGORY_LABELS: Record<QuotaCategory, string> = {
  directorTokens: "today's directing budget",
  sunoGens: "today's music budget",
  cloudCaptionFrames: "today's cloud captioning budget",
  sttSeconds: "today's cloud transcription budget",
};

/** "today's directing budget" — plain words for a QuotaCategory. */
export function fmtQuotaCategory(category: QuotaCategory): string {
  return QUOTA_CATEGORY_LABELS[category] ?? "today's budget";
}

/** "resets in about 3 hours" / "resets at midnight UTC" — friendly resetsAt wording. */
export function fmtResetsAt(resetsAtIso: string, nowMs: number = Date.now()): string {
  const resetsAtMs = new Date(resetsAtIso).getTime();
  if (!Number.isFinite(resetsAtMs)) return "resets soon";
  const diffMs = resetsAtMs - nowMs;
  if (diffMs <= 0) return "resets any moment now";
  const hours = Math.round(diffMs / 3_600_000);
  if (hours <= 1) return "resets within the hour";
  if (hours < 20) return `resets in about ${hours} hours`;
  return "resets at midnight UTC";
}
