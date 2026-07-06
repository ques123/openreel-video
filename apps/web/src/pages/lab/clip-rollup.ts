/**
 * Pure fleet/clip-list derivations for the Perception Lab page: the header
 * status rollup at 90-clip scale, per-clip activity labels (queued vs
 * actively analyzing — the decode queue is serialized, so "analyzing…" on
 * every row was a lie), name/status filtering, shift-click range-selection
 * math, and bulk-enhance run summaries. No React, no workers — everything
 * here is unit-tested.
 */

/** The LabClip fields these derivations read (a full LabClip satisfies it). */
export interface RollupClip {
  clipId: string;
  fileName: string;
  status: "analyzing" | "done" | "error" | "cancelled";
  error?: string;
  durationS: number;
  analyzedThroughS: number | null;
  decodeT: number;
  ingestProgress: number | null;
  ingestWindow?: { window: number; windows: number; analyzedThroughS: number };
  captionsDone: number;
  captionsTotal: number;
}

/** Reducer status, with "analyzing" split into queued vs actively working. */
export type DerivedClipStatus = "done" | "error" | "cancelled" | "analyzing" | "queued";

/**
 * Split the reducer's single "analyzing" status. The visual pass is
 * serialized (one clip decodes at a time), so an analyzing clip that has
 * produced NO pipeline signal yet (no ingest progress, no metadata, no
 * decoded frames) hasn't started — it's queued behind the active one.
 */
export function derivedStatusOf(clip: RollupClip): DerivedClipStatus {
  if (clip.status !== "analyzing") return clip.status;
  const started =
    clip.ingestProgress !== null || clip.decodeT > 0 || clip.durationS > 0;
  return started ? "analyzing" : "queued";
}

/**
 * What an actively-analyzing clip is doing right now, as a short label:
 * "ingesting 40%" (OPFS copy) → "scanning 62%" (decode + shots; multi-pass
 * long clips include their window) → "transcribing" (decode finished,
 * whisper/embeds still running). Dense captioning happens AFTER a clip is
 * done (background enrichment) and is reported by the rollup separately.
 */
export function stageLabelOf(clip: RollupClip): string {
  if (clip.ingestProgress !== null) {
    return `ingesting ${Math.round(clip.ingestProgress * 100)}%`;
  }
  const spanS = clip.analyzedThroughS ?? clip.durationS;
  const pct = spanS > 0 ? Math.min(1, clip.decodeT / spanS) : 0;
  if (clip.ingestWindow && clip.ingestWindow.windows > 1) {
    return `scanning pass ${clip.ingestWindow.window}/${clip.ingestWindow.windows} · ${Math.round(pct * 100)}%`;
  }
  if (spanS > 0 && pct >= 0.99) return "transcribing";
  return `scanning ${Math.round(pct * 100)}%`;
}

export interface FleetRollup {
  total: number;
  done: number;
  error: number;
  cancelled: number;
  /** Actively working (not just enqueued). Usually 0 or 1 clip decodes at a
   * time, but a clip can still be transcribing while the next one decodes. */
  analyzing: number;
  queued: number;
  /** First actively-analyzing clip in list order — the queue's visible head. */
  active: { clipId: string; fileName: string; stage: string } | null;
  /** Background dense-caption progress summed over clips still describing. */
  describing: { done: number; total: number } | null;
}

/** Derive the header's fleet status strip from the clip list. */
export function deriveFleetRollup(clips: RollupClip[]): FleetRollup {
  const rollup: FleetRollup = {
    total: clips.length,
    done: 0,
    error: 0,
    cancelled: 0,
    analyzing: 0,
    queued: 0,
    active: null,
    describing: null,
  };
  let describeDone = 0;
  let describeTotal = 0;
  for (const clip of clips) {
    const status = derivedStatusOf(clip);
    rollup[status] += 1;
    if (status === "analyzing" && !rollup.active) {
      rollup.active = {
        clipId: clip.clipId,
        fileName: clip.fileName,
        stage: stageLabelOf(clip),
      };
    }
    if (clip.captionsTotal > 0 && clip.captionsDone < clip.captionsTotal) {
      describeDone += clip.captionsDone;
      describeTotal += clip.captionsTotal;
    }
  }
  if (describeTotal > 0) rollup.describing = { done: describeDone, total: describeTotal };
  return rollup;
}

export type StatusFilter = "all" | DerivedClipStatus;

export const STATUS_FILTERS: StatusFilter[] = [
  "all",
  "done",
  "error",
  "cancelled",
  "analyzing",
  "queued",
];

/** Case-insensitive name substring + derived-status filter, order preserved. */
export function filterClips<T extends RollupClip>(
  clips: T[],
  nameQuery: string,
  status: StatusFilter,
): T[] {
  const q = nameQuery.trim().toLowerCase();
  if (!q && status === "all") return clips;
  return clips.filter((c) => {
    if (q && !c.fileName.toLowerCase().includes(q)) return false;
    if (status !== "all" && derivedStatusOf(c) !== status) return false;
    return true;
  });
}

/**
 * Shift-click range selection: the inclusive id range between the last
 * clicked checkbox (anchor) and the shift-clicked target, in the CURRENTLY
 * DISPLAYED order (filtering changes what "between" means, deliberately).
 * A missing/vanished anchor or target degrades to just the target.
 */
export function clipIdRange(
  orderedIds: string[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const ti = orderedIds.indexOf(targetId);
  if (ti === -1) return [targetId];
  const ai = anchorId !== null ? orderedIds.indexOf(anchorId) : -1;
  if (ai === -1) return [targetId];
  const [lo, hi] = ai < ti ? [ai, ti] : [ti, ai];
  return orderedIds.slice(lo, hi + 1);
}

/** One clip's outcome in a bulk enhance run. */
export interface BulkClipResult {
  clipId: string;
  fileName: string;
  ok: boolean;
  /** Failure message (absent on success). */
  error?: string;
}

export interface BulkRunSummary {
  total: number;
  succeeded: number;
  failed: BulkClipResult[];
}

export function summarizeBulkRun(results: BulkClipResult[]): BulkRunSummary {
  const failed = results.filter((r) => !r.ok);
  return { total: results.length, succeeded: results.length - failed.length, failed };
}

/** Clip ids a "retry failed" pass should re-run (order kept, de-duped). */
export function retryClipIds(summary: BulkRunSummary): string[] {
  return [...new Set(summary.failed.map((f) => f.clipId))];
}

/** "85/91 enhanced, 6 failed" (failure clause only when something failed). */
export function formatBulkSummary(summary: BulkRunSummary): string {
  const base = `${summary.succeeded}/${summary.total} enhanced`;
  return summary.failed.length > 0 ? `${base}, ${summary.failed.length} failed` : base;
}

/** "1:23.4" — same mm:ss.s shape the filmstrip header uses. */
export function fmtClipTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}
