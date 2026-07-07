/**
 * Reduces the director loop's raw DirectorActivity stream (packages/core's
 * director-types.ts — "round"/"search"/"note"/"rejected", the same feed the
 * admin DirectorPanel renders verbatim as an engineering log) down to the
 * public narrative types.ts specifies: plain human lines, search queries
 * verbatim in quotes, nothing that looks like internals.
 *
 * Deliberate choices (see docs/wizz-video-plan.md §10 Scene 4 — "the
 * director's real activity streams as narrative including verbatim search
 * queries"):
 * - "search" -> always surfaces, verbatim query, quoted, isQuery: true. This
 *   is the heart of the public narrative.
 * - "round" -> only round 1 produces a line ("reading through your footage"
 *   for a fresh generate, "reviewing your notes" for a refine's first round)
 *   — later rounds are plumbing (another trip to the model after tool
 *   results came back) and would just repeat noise.
 * - "rejected" -> becomes a generic "double-checking the cut" note — the
 *   raw validation errors are internal detail (shot ids, clamped ranges)
 *   that must never leak to the public UI.
 * - "note" -> DROPPED. This is unfiltered model prose; unlike "search" (a
 *   tool-call argument this app fully controls the framing of), free text
 *   from the LLM could say almost anything and isn't part of the controlled
 *   reading/searching/assembling/reviewing vocabulary this reduction exists
 *   to produce.
 * - "assembling" has no DirectorActivity counterpart at all — it narrates
 *   the POST-loop work (title, thumbnails, music) use-public-director.ts
 *   does once a storyboard is accepted; see ASSEMBLING_LINE below, appended
 *   by the hook itself, not by this reducer.
 */
import type { DirectorActivity } from "@openreel/core";

export interface NarrativeLine {
  text: string;
  isQuery: boolean;
}

/** Appended once the loop accepts a storyboard, before title/music finalize — see the module doc. */
export const ASSEMBLING_LINE: NarrativeLine = { text: "assembling your cut", isQuery: false };

function firstRoundLine(isRefine: boolean): NarrativeLine {
  return {
    text: isRefine ? "reviewing your notes" : "reading through your footage",
    isQuery: false,
  };
}

/**
 * Reduces one DirectorActivity event to zero-or-one public narrative lines.
 * `isRefine` distinguishes a fresh generate()'s round 1 from a refine()'s —
 * both loops emit `{kind:"round", round:1}` as their very first activity.
 */
export function reduceDirectorActivity(
  activity: DirectorActivity,
  isRefine: boolean,
): NarrativeLine | null {
  switch (activity.kind) {
    case "round":
      return activity.round === 1 ? firstRoundLine(isRefine) : null;
    case "search":
      // Bare query only — the renderer owns the "Looking for:" label + quotes
      // + italic styling for isQuery lines (DirectingScene). Emitting the
      // label here too double-prefixes it in the UI.
      return { text: activity.query, isQuery: true };
    case "rejected":
      return { text: "double-checking the cut", isQuery: false };
    case "note":
      return null;
  }
}

/** Reduces a whole activity log at once (e.g. replaying a persisted run) — order preserved, nulls dropped. */
export function reduceDirectorActivityLog(
  activities: DirectorActivity[],
  isRefine: boolean,
): NarrativeLine[] {
  const lines: NarrativeLine[] = [];
  for (const activity of activities) {
    const line = reduceDirectorActivity(activity, isRefine);
    if (line) lines.push(line);
  }
  return lines;
}
