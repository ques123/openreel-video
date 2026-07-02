/**
 * Storyboard validation: turn a raw submit_storyboard tool call (untrusted
 * JSON from the LLM) into a clean Storyboard, or a list of errors to bounce
 * back so the model can fix its submission.
 *
 * Policy: errors reject the WHOLE submission (the loop feeds them back and
 * the model retries); warnings record clamps/drift we silently accepted and
 * are surfaced in the UI.
 */

import type { ClipDossier, Shot } from "./types";
import type { Storyboard, StoryboardItem } from "./director-types";

export interface StoryboardValidation {
  /** Null when the submission is structurally unusable (nothing salvageable). */
  storyboard: Storyboard | null;
  errors: string[];
  warnings: string[];
}

export interface ValidateStoryboardOpts {
  targetDurationS?: number | null;
  /** Segments shorter than this after clamping are rejected. */
  minItemS?: number;
}

/** Target-duration tolerance: outside ±10% is an error, ±5-10% a warning. */
const DURATION_ERROR_FRAC = 0.1;
const DURATION_WARN_FRAC = 0.05;
const DEFAULT_MIN_ITEM_S = 0.3;

const fmtS = (s: number) => s.toFixed(1);

function findCoveringShot(dossier: ClipDossier, t: number): Shot | null {
  for (const shot of dossier.shots) {
    if (t >= shot.tStart && t < shot.tEnd) return shot;
  }
  return dossier.shots.length > 0 ? dossier.shots[dossier.shots.length - 1] : null;
}

export function validateStoryboard(
  rawArgsJson: string,
  dossiers: ClipDossier[],
  opts: ValidateStoryboardOpts = {},
): StoryboardValidation {
  const minItemS = opts.minItemS ?? DEFAULT_MIN_ITEM_S;
  const targetDurationS = opts.targetDurationS ?? null;
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(rawArgsJson);
  } catch {
    return { storyboard: null, errors: ["arguments are not valid JSON"], warnings };
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { items?: unknown }).items)) {
    return { storyboard: null, errors: ['missing "items" array'], warnings };
  }
  const rawObj = raw as { title?: unknown; notes?: unknown; items: unknown[] };
  if (rawObj.items.length === 0) {
    return { storyboard: null, errors: ['"items" is empty'], warnings };
  }

  const byClipId = new Map(dossiers.map((d) => [d.clipId, d]));
  const byFileName = new Map(dossiers.map((d) => [d.fileName, d]));
  const knownIds = dossiers.map((d) => d.clipId).join(", ");

  const items: StoryboardItem[] = [];
  rawObj.items.forEach((rawItem, i) => {
    const label = `item ${i + 1}`;
    if (typeof rawItem !== "object" || rawItem === null) {
      errors.push(`${label}: not an object`);
      return;
    }
    const it = rawItem as Record<string, unknown>;

    // Models occasionally put the file name where the clip id belongs.
    const idField = typeof it.clipId === "string" ? it.clipId : "";
    const dossier = byClipId.get(idField) ?? byFileName.get(idField);
    if (!dossier) {
      errors.push(`${label}: unknown clipId "${idField}" — known: ${knownIds}`);
      return;
    }

    let shotIndex: number | null =
      typeof it.shotIndex === "number" && Number.isInteger(it.shotIndex) ? it.shotIndex : null;
    let shot: Shot | null = null;
    if (shotIndex !== null) {
      shot = dossier.shots.find((s) => s.index === shotIndex) ?? null;
      if (!shot) {
        warnings.push(`${label}: shot #${shotIndex} does not exist in ${dossier.clipId}; used clip bounds`);
        shotIndex = null;
      }
    }

    const rawIn = typeof it.in === "number" ? it.in : NaN;
    const rawOut = typeof it.out === "number" ? it.out : NaN;
    if (!Number.isFinite(rawIn) || !Number.isFinite(rawOut)) {
      errors.push(`${label}: "in"/"out" must be finite numbers`);
      return;
    }

    // Clamp to the shot when anchored, else to the clip's ANALYZED range —
    // content past analyzedThroughS is unknown to the model, never select it.
    const lo = shot ? shot.tStart : 0;
    const hi = shot ? shot.tEnd : (dossier.analyzedThroughS ?? dossier.durationS);
    const inS = Math.min(Math.max(rawIn, lo), hi);
    const outS = Math.min(Math.max(rawOut, lo), hi);
    if (inS !== rawIn || outS !== rawOut) {
      warnings.push(
        `${label}: range ${fmtS(rawIn)}-${fmtS(rawOut)}s clamped to ${fmtS(inS)}-${fmtS(outS)}s` +
          (shot ? ` (shot #${shot.index})` : ""),
      );
    }
    if (outS - inS < minItemS) {
      errors.push(
        `${label}: only ${fmtS(outS - inS)}s long after clamping to ` +
          `${fmtS(lo)}-${fmtS(hi)}s (min ${fmtS(minItemS)}s) — pick a range inside the bounds`,
      );
      return;
    }

    const coveringShot = shot ?? findCoveringShot(dossier, inS);
    items.push({
      clipId: dossier.clipId,
      fileName: dossier.fileName,
      shotIndex: shot ? shot.index : null,
      inS,
      outS,
      role: typeof it.role === "string" && it.role.trim() ? it.role.trim() : "segment",
      why: typeof it.why === "string" ? it.why.trim() : "",
      thumbnailDataUrl: coveringShot?.thumbnailDataUrl ?? null,
    });
  });

  if (items.length === 0) {
    return { storyboard: null, errors, warnings };
  }

  if (targetDurationS !== null && targetDurationS > 0) {
    let total = 0;
    for (const item of items) total += item.outS - item.inS;
    const drift = Math.abs(total - targetDurationS) / targetDurationS;
    if (drift > DURATION_ERROR_FRAC) {
      errors.push(
        `total duration ${fmtS(total)}s is ${total > targetDurationS ? "over" : "under"} the ` +
          `${fmtS(targetDurationS)}s target by ${Math.round(drift * 100)}% (max ±10%) — ` +
          `adjust segment lengths or count`,
      );
    } else if (drift > DURATION_WARN_FRAC) {
      warnings.push(
        `total duration ${fmtS(total)}s vs target ${fmtS(targetDurationS)}s (${Math.round(drift * 100)}% off)`,
      );
    }
  }

  return {
    storyboard: {
      title: typeof rawObj.title === "string" ? rawObj.title : null,
      notes: typeof rawObj.notes === "string" ? rawObj.notes : null,
      items,
    },
    errors,
    warnings,
  };
}
