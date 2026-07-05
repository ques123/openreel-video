/**
 * Pure prompt-derivation for the contextual background-music feature. After
 * the director produces a storyboard, we generate an instrumental bed via
 * sunoapi.org. The web layer owns the LLM call and the network round trip;
 * everything here is deterministic and unit-tested: the heuristic fallback
 * used when the LLM brief-writer fails (or before it's called), and the
 * limit-clamping applied to EVERY brief regardless of origin.
 */

import type { Storyboard } from "./director-types";

export interface MusicBrief {
  style: string;
  title: string;
  prompt: string;
}

/** sunoapi.org V5 custom-mode field limits. */
export const MUSIC_LIMITS = { style: 1000, title: 100, prompt: 5000 } as const;

/** Truncate on a word boundary, never mid-word, never over the limit. */
function truncateWords(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Enforce MUSIC_LIMITS on any brief — LLM-written or heuristic. */
export function clampMusicBrief(b: MusicBrief): MusicBrief {
  return {
    style: truncateWords(b.style, MUSIC_LIMITS.style),
    title: truncateWords(b.title, MUSIC_LIMITS.title),
    prompt: truncateWords(b.prompt, MUSIC_LIMITS.prompt),
  };
}

/** Rough editorial pacing read from the items' roles, cheapest signal first. */
function paceFromRoles(roles: string[]): string {
  const has = (needle: string) => roles.some((r) => r.toLowerCase().includes(needle));
  if (has("hook") && has("payoff")) return "building tension through the middle to a satisfying payoff";
  if (has("hook")) return "an attention-grabbing opening that settles into a steady groove";
  if (has("payoff") || has("outro")) return "a gentle build toward a resolved, uplifting close";
  if (has("action")) return "energetic momentum with rhythmic drive";
  return "an even, unobtrusive pace that supports the picture without pulling focus";
}

const FIRST_WORDS = 6;

function firstWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(" ");
}

/**
 * Deterministic heuristic brief, used when the LLM brief-writer fails (or as
 * the seed before it's called). Derives a style line from the user brief and
 * storyboard signals (title/notes/item roles), sensible instrumental
 * defaults when those signals are thin, and a title from the storyboard
 * title or the first few words of the user brief.
 */
export function buildMusicBriefFallback(
  userBrief: string,
  storyboard: Storyboard | null,
  targetS: number | null,
): MusicBrief {
  const brief = userBrief.trim();
  const roles = storyboard?.items.map((i) => i.role).filter(Boolean) ?? [];
  const hasSignal = brief.length > 0 || Boolean(storyboard?.title) || Boolean(storyboard?.notes) || roles.length > 0;

  // Thin input (no brief, no storyboard signal): fall back to a cinematic,
  // travel-friendly default that works under almost any footage.
  const genre = hasSignal
    ? "cinematic acoustic pop with light electronic textures"
    : "cinematic travel/vlog underscore, warm acoustic guitar and soft piano over subtle electronic percussion";

  const moodBits: string[] = [];
  if (brief) moodBits.push(brief);
  if (storyboard?.title) moodBits.push(`matching the mood of "${storyboard.title}"`);
  if (storyboard?.notes) moodBits.push(storyboard.notes);

  const pace = paceFromRoles(roles);
  const durationBit =
    targetS != null && targetS > 0 ? `arranged for roughly ${Math.round(targetS)} seconds` : null;

  const styleParts = [
    genre,
    moodBits.length > 0 ? moodBits.join("; ") : null,
    pace,
    durationBit,
    "instrumental, no vocals",
  ].filter((p): p is string => Boolean(p && p.trim()));

  const style = styleParts.join(", ");

  const title = storyboard?.title
    ? `${storyboard.title} (score)`
    : brief
      ? `${firstWords(brief, FIRST_WORDS)} (score)`
      : "Background Score (score)";

  const promptParts = [
    `Instrumental background music for a video edit.`,
    brief ? `The video is about: ${brief}.` : null,
    storyboard?.title ? `Storyboard title: "${storyboard.title}".` : null,
    storyboard?.notes ? `Editor notes: ${storyboard.notes}.` : null,
    roles.length > 0 ? `Shot roles in order: ${roles.join(", ")}.` : null,
    `Pacing: ${pace}.`,
    durationBit ? `Target length: ${durationBit}.` : null,
    "No vocals, no lyrics — a clean instrumental bed that sits under dialogue and sound effects without competing for attention.",
  ].filter((p): p is string => Boolean(p && p.trim()));

  const prompt = promptParts.join(" ");

  return clampMusicBrief({ style, title, prompt });
}
