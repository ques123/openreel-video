/**
 * Prompt construction for the director: dossier -> compact text the LLM can
 * reason over, the system prompt (persona + craft + data caveats), and the
 * formatters for tool results fed back into the conversation.
 *
 * Everything here is pure string building — no I/O, no model calls — so it
 * is fully unit-testable and the exact bytes sent to the LLM are auditable.
 */

import type { SearchResult } from "./retrieval";
import type { ClipDossier } from "./types";
import { storyboardDurationS, type Storyboard } from "./director-types";

/** Per-clip transcript budget; talky clips get truncated, not dropped. */
const DEFAULT_MAX_TRANSCRIPT_CHARS = 8000;

const fmtS = (s: number) => s.toFixed(1);

/** Deterministic "2026-06-24 05:42 UTC" — only relative order matters. */
const fmtRecordedAt = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function dossierToPromptText(
  dossier: ClipDossier,
  opts: { maxTranscriptChars?: number } = {},
): string {
  const maxTranscriptChars = opts.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const lines: string[] = [];

  lines.push(
    `CLIP ${dossier.clipId} "${dossier.fileName}"  duration ${fmtS(dossier.durationS)}s  ${dossier.width}x${dossier.height}` +
      (dossier.recordedAt !== null ? `  recorded ${fmtRecordedAt(dossier.recordedAt)}` : ""),
  );
  if (dossier.analyzedThroughS !== null) {
    lines.push(
      `  !! PARTIAL: analyzed only through ${fmtS(dossier.analyzedThroughS)}s — ` +
        `shots/transcript below cover [0, ${fmtS(dossier.analyzedThroughS)}s]; do not reference later times.`,
    );
  }

  lines.push(
    "  SHOTS (index  start-end  len  motion(0-255, <40 typical)  peak@  sharpness(~200+ = sharp)):",
  );
  for (const shot of dossier.shots) {
    const len = shot.tEnd - shot.tStart;
    lines.push(
      `    #${shot.index}  ${fmtS(shot.tStart)}-${fmtS(shot.tEnd)}s  ${fmtS(len)}s  ` +
        `motion ${Math.round(shot.motion.score)} peak@${fmtS(shot.motion.peakTime)}  ` +
        `sharp ${Math.round(shot.quality.sharpness)}`,
    );
  }

  if (dossier.transcript.length === 0) {
    lines.push("  TRANSCRIPT: (no speech detected)");
  } else {
    lines.push("  TRANSCRIPT:");
    let used = 0;
    for (const seg of dossier.transcript) {
      const line = `    [${fmtS(seg.t0)}-${fmtS(seg.t1)}] ${seg.text.trim()}`;
      if (used + line.length > maxTranscriptChars) {
        lines.push("    [transcript truncated]");
        break;
      }
      lines.push(line);
      used += line.length;
    }
  }

  return lines.join("\n");
}

/** Chronological copy: known recording times first (oldest→newest), unknown last. */
export function sortByRecordedAt(dossiers: ClipDossier[]): ClipDossier[] {
  return [...dossiers].sort(
    (a, b) => (a.recordedAt ?? Infinity) - (b.recordedAt ?? Infinity),
  );
}

export function dossiersToPromptText(dossiers: ClipDossier[]): string {
  return sortByRecordedAt(dossiers)
    .map((d) => dossierToPromptText(d))
    .join("\n\n");
}

export function buildSystemPrompt(): string {
  return `You are a video editor's director. You receive machine analysis ("dossiers") of raw clips: shot boundaries with motion and sharpness metrics, and a timecoded speech transcript. You have NOT seen the pixels. To learn what a shot shows visually, use the search_shots tool (CLIP text-to-image retrieval over the shots).

TOOLS
- search_shots(query, topK): use short caption-style visual queries ("a person cutting open a durian", not "durian cutting scene analysis"). Results carry a "confident" flag: confident hits clearly separate from the rest of the footage and are trustworthy; non-confident hits are weak — corroborate them (transcript, motion, another query) or avoid building key moments on them. No confident hits usually means the footage does not contain it; do not force it.
- submit_storyboard(...): call exactly once, when the cut is decided. "in"/"out" are seconds within the clip; prefer trimming inside one shot's boundaries; every item needs a role and a one-line "why". If the submission is rejected with errors, fix them and resubmit.

EDITING CRAFT
- Open with a hook: the strongest 2-4 seconds (high motion, striking visual, or a compelling spoken line) — earn attention before giving context.
- Vary pacing: alternate segment lengths; high-motion shots can run shorter, calm scenic shots slightly longer. Avoid two near-identical shots back to back.
- Prefer sharp shots (sharpness ~200+; higher is sharper). Motion is mean frame difference on a 0-255 scale, typically under 40: ~25+ is energetic, single digits is static. The peak@ time marks the liveliest moment — useful when trimming.
- Cut speech on sentence boundaries using the transcript timings; never clip mid-word. Silence between segments is fine.
- Respect chronology: clips carry recording times and are listed oldest-first. A montage reads as a story — by default keep segments in recording order so the viewer experiences the trip the way it happened. Deliberate exceptions are fine (e.g. pulling ONE strong later moment forward as the hook, then running chronologically), but never shuffle time arbitrarily.
- Hit the target duration within ±10%. Add up your segment durations BEFORE submitting.

DATA CAVEATS
- The transcript comes from Whisper and hallucinates on non-speech or non-English audio: repeated loops ("check, check, check…"), stray phrases over music or wind. Distrust repetitive or context-free lines; treat them as no-speech.
- A clip marked PARTIAL was only analyzed through the stated time; never select ranges beyond it.
- Metrics are heuristics, not ground truth: use them to rank candidates, not as facts to assert.

PROCESS
Read the brief and dossiers; plan the arc (hook -> development -> payoff); run a few targeted searches to verify what the shots actually show; then submit. Be decisive — you have a limited number of tool rounds.`;
}

export function buildBriefMessage(brief: string, targetDurationS: number | null): string {
  const lines = ["BRIEF: " + brief.trim()];
  if (targetDurationS !== null) {
    lines.push(`TARGET DURATION: ${fmtS(targetDurationS)}s (stay within ±10%)`);
  }
  return lines.join("\n");
}

export function buildDossierMessage(dossiers: ClipDossier[]): string {
  return (
    `FOOTAGE: ${dossiers.length} analyzed clip${dossiers.length === 1 ? "" : "s"} — ` +
    `this is ALL the available footage, listed in RECORDING ORDER (oldest first).\n\n` +
    dossiersToPromptText(dossiers)
  );
}

export function formatSearchResults(query: string, result: SearchResult): string {
  if (result.hits.length === 0) {
    return `search_shots("${query}"): no shots with embeddings yet.`;
  }
  const lines = [
    `search_shots("${query}") — ${result.hits.length} hits ` +
      `(population mean ${result.mean.toFixed(3)}, std ${result.std.toFixed(3)}):`,
  ];
  for (const hit of result.hits) {
    const s = hit.shot;
    lines.push(
      `  ${hit.confident ? "CONFIDENT" : "weak     "}  score ${hit.score.toFixed(3)}  ` +
        `clip ${hit.clipId} shot #${s.index}  ${fmtS(s.tStart)}-${fmtS(s.tEnd)}s  ` +
        `motion ${Math.round(s.motion.score)}  sharp ${Math.round(s.quality.sharpness)}`,
    );
  }
  if (!result.hits.some((h) => h.confident)) {
    lines.push("  (no confident hits — the footage likely does not contain this)");
  }
  return lines.join("\n");
}

export function formatValidationFeedback(errors: string[], warnings: string[]): string {
  const lines = ["Storyboard REJECTED — fix these and call submit_storyboard again:"];
  for (const e of errors) lines.push(`  - ${e}`);
  if (warnings.length > 0) {
    lines.push("Also note (not blocking):");
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

/**
 * Refine message: embeds the CURRENT storyboard (including any manual removes
 * or reorders the user made in the UI since the last submit) so the model
 * revises what the user actually sees, not what it last submitted.
 */
export function buildRefineMessage(
  feedback: string,
  current: Storyboard,
  targetDurationS: number | null = null,
): string {
  const items = current.items.map((it) => ({
    clipId: it.clipId,
    shotIndex: it.shotIndex,
    in: Number(it.inS.toFixed(1)),
    out: Number(it.outS.toFixed(1)),
    role: it.role,
    why: it.why,
  }));
  return (
    `The user reviewed the storyboard (possibly edited — this is the current state, ` +
    `total ${fmtS(storyboardDurationS(current))}s):\n` +
    JSON.stringify({ title: current.title, items }, null, 1) +
    `\n\nUSER FEEDBACK: ${feedback.trim()}\n` +
    (targetDurationS !== null
      ? `TARGET DURATION is now ${fmtS(targetDurationS)}s (stay within ±10%).\n`
      : "") +
    `Revise the storyboard accordingly (search more if needed) and submit_storyboard again.`
  );
}
