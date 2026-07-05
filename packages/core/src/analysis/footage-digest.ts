/**
 * Footage digest: compress N ClipDossiers into a compact text summary (a few
 * thousand chars) an LLM can use to propose contextually-grounded director
 * briefs — cheap enough to include in every brief-suggestion call, unlike the
 * full dossier prompt built for the director's tool-calling loop.
 */

import { mergeDenseCaptions, type TimelineSegment } from "./caption-text";
import type { ClipDossier, TranscriptSegment } from "./types";

export interface FootageDigestOptions {
  /** Hard cap on the returned string length. Default 6000. */
  charBudget?: number;
}

const DEFAULT_CHAR_BUDGET = 6000;

/** "m:ss", rounded to the nearest second (times are approximate signal here). */
function fmtMs(s: number): string {
  const total = Math.max(0, Math.round(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Chronological: known recording times first (oldest->newest), unknown last by name. */
function sortDossiers(dossiers: ClipDossier[]): ClipDossier[] {
  return [...dossiers].sort((a, b) => {
    if (a.recordedAt !== null && b.recordedAt !== null) return a.recordedAt - b.recordedAt;
    if (a.recordedAt !== null) return -1;
    if (b.recordedAt !== null) return 1;
    return a.fileName.localeCompare(b.fileName);
  });
}

function contentWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Keep the `limit` longest-duration segments, but preserve chronological order. */
function pickSegments(segments: TimelineSegment[], limit: number): TimelineSegment[] {
  if (limit <= 0) return [];
  if (segments.length <= limit) return segments;
  const kept = new Set(
    [...segments].sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0)).slice(0, limit),
  );
  return segments.filter((s) => kept.has(s));
}

/** Keep the `limit` most content-rich (longest) lines, skip blanks, preserve chronological order. */
function pickTranscriptLines(
  transcript: TranscriptSegment[],
  limit: number,
): TranscriptSegment[] {
  const nonBlank = transcript.filter((seg) => seg.text.trim().length > 0);
  if (limit <= 0) return [];
  if (nonBlank.length <= limit) return nonBlank;
  const kept = new Set(
    [...nonBlank].sort((a, b) => contentWordCount(b.text) - contentWordCount(a.text)).slice(0, limit),
  );
  return nonBlank.filter((seg) => kept.has(seg));
}

function buildClipBlock(
  dossier: ClipDossier,
  position: number,
  total: number,
  segCap: number,
  transcriptCap: number,
): string {
  const lines: string[] = [];
  const shotCount = dossier.shots.length;
  lines.push(
    `Clip ${position + 1}/${total} — ${dossier.fileName} ` +
      `(${Math.round(dossier.durationS)}s, ${shotCount} shot${shotCount === 1 ? "" : "s"})`,
  );

  // Cloud descriptions are higher quality — prefer them wholesale over local
  // ones for the scene timeline when any exist.
  const usedCloud = dossier.cloudDenseCaptions.length > 0;
  const sourceCaptions = usedCloud ? dossier.cloudDenseCaptions : dossier.denseCaptions;
  let wroteContent = false;

  if (sourceCaptions.length > 0) {
    const segments = pickSegments(mergeDenseCaptions(sourceCaptions), segCap);
    for (const seg of segments) {
      const range = seg.t1 > seg.t0 ? `${fmtMs(seg.t0)}–${fmtMs(seg.t1)}` : fmtMs(seg.t0);
      lines.push(`  ${range} ${seg.text}`);
      wroteContent = true;
    }
  }

  // Timeline is local-only (or absent) — surface a few cloud SHOT captions
  // too, since they're the best information available for this clip. Cap
  // shrinks in lockstep with segCap so it also degrades under budget pressure.
  if (!usedCloud && dossier.cloudShotCaptions.length > 0) {
    const bonusCap = Math.min(3, segCap);
    const seen = new Set<string>();
    for (const c of dossier.cloudShotCaptions) {
      if (seen.size >= bonusCap) break;
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      lines.push(`  shot: ${c.text}`);
      wroteContent = true;
    }
  }

  if (!wroteContent) {
    lines.push("  (no captions yet)");
  }

  if (transcriptCap > 0 && dossier.transcript.length > 0) {
    const picked = pickTranscriptLines(dossier.transcript, transcriptCap);
    for (const seg of picked) {
      lines.push(`  said @${fmtMs(seg.t0)}: "${seg.text.trim()}"`);
    }
  }

  return lines.join("\n");
}

/**
 * Stepwise degradation levels, tried in order until the digest fits the char
 * budget. Approximates a "per-clip fair share" without literally dividing the
 * budget: each step uniformly trims every clip's detail one notch, cheapest
 * detail first, header lines are never dropped.
 */
const DEGRADE_LEVELS: { seg: number; transcript: number }[] = [
  { seg: 8, transcript: 5 },
  { seg: 5, transcript: 5 },
  { seg: 3, transcript: 5 },
  { seg: 3, transcript: 3 },
  { seg: 3, transcript: 1 },
  { seg: 3, transcript: 0 },
  { seg: 1, transcript: 0 },
  { seg: 0, transcript: 0 },
];

export function buildFootageDigest(
  dossiers: ClipDossier[],
  opts: FootageDigestOptions = {},
): string {
  if (dossiers.length === 0) return "";
  const charBudget = opts.charBudget ?? DEFAULT_CHAR_BUDGET;
  const sorted = sortDossiers(dossiers);

  let digest = "";
  for (const level of DEGRADE_LEVELS) {
    digest = sorted
      .map((d, i) => buildClipBlock(d, i, sorted.length, level.seg, level.transcript))
      .join("\n");
    if (digest.length <= charBudget) break;
  }
  return digest;
}
