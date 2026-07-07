/**
 * Pure title fallback for the public cut, mirroring the deterministic
 * heuristic pattern packages/core/src/analysis/music-prompt.ts's
 * buildMusicBriefFallback already uses for its own title field: derive
 * something reasonable from the user's brief when there's nothing better,
 * never throw, never return an empty string.
 *
 * Used by use-public-director.ts as the LAST resort for PublicCut.title:
 * the storyboard/notes title (from the director IR) wins when present;
 * failing that, one cheap aux LLM call tries to write something better;
 * failing THAT too, this function guarantees a title exists regardless.
 */

const FILM_TITLE_MAX_WORDS = 6;

/** Title-cases a short label ("Cinematic" stays "Cinematic"; multi-word labels keep their given casing). */
export function buildFilmTitleFallback(brief: string, styleLabel?: string | null): string {
  const trimmed = brief.trim();
  if (trimmed) {
    const words = trimmed.split(/\s+/).filter(Boolean);
    const truncated = words.slice(0, FILM_TITLE_MAX_WORDS).join(" ");
    return words.length > FILM_TITLE_MAX_WORDS ? `${truncated}…` : truncated;
  }
  return styleLabel ? `${styleLabel} Cut` : "Untitled Cut";
}
