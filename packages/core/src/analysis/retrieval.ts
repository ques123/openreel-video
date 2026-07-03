/**
 * Text -> shot retrieval over dossier embeddings.
 * All embeddings are L2-normalized, so cosine similarity = dot product.
 *
 * Two-tower cosine scores are only meaningful RELATIVE to each other — the
 * population of scores for a query sits in a model-specific band (CLIP
 * ~0.15-0.22; SigLIP2 lower, often near 0), with true matches a few standard
 * deviations above. We therefore label a hit `confident` when it clearly
 * separates from the field (z-score) or sits within a whisker of the best
 * hit; the UI de-emphasizes the rest.
 */

import { dot } from "./shot-metrics";
import type { ClipDossier, Shot } from "./types";

/**
 * CLIP retrieves noticeably better with a caption-shaped prompt than a bare
 * keyword ("dog" -> "a photo of a dog"). Leave longer/sentence queries as-is.
 */
export function templateQuery(query: string): string {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return trimmed;
  if (/^(a|an|the|photo|picture|someone|people|person)\b/i.test(trimmed)) return trimmed;
  return `a photo of ${/^[aeiou]/i.test(trimmed) ? "an" : "a"} ${trimmed}`;
}

export interface SearchHit {
  clipId: string;
  fileName: string;
  shot: Shot;
  score: number;
  /** True when the score clearly separates from the population for this query. */
  confident: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Mean cosine over ALL shots for this query (the "background" level). */
  mean: number;
  std: number;
}

/** z-score above which a hit counts as a real match. */
const CONFIDENT_Z = 2.0;
/**
 * Absolute cosine margin above the population mean that also counts as
 * confident — z-scores are unstable on small corpora (a handful of shots).
 */
const CONFIDENT_MARGIN = 0.04;
/** Hits within this cosine distance of the best hit stay confident (ties). */
const BEST_WHISKER = 0.02;

export function searchShots(
  queryEmbedding: Float32Array,
  dossiers: ClipDossier[],
  topK = 12,
): SearchResult {
  const scored: Omit<SearchHit, "confident">[] = [];
  for (const dossier of dossiers) {
    for (const shot of dossier.shots) {
      const embeddings =
        shot.frameEmbeddings && shot.frameEmbeddings.length > 0
          ? shot.frameEmbeddings
          : shot.embedding
            ? [shot.embedding]
            : [];
      if (embeddings.length === 0) continue;
      // A shot matches if ANY of its sampled frames matches — long shots
      // contain more than the one representative frame.
      let score = -Infinity;
      for (const e of embeddings) score = Math.max(score, dot(queryEmbedding, e));
      scored.push({ clipId: dossier.clipId, fileName: dossier.fileName, shot, score });
    }
  }

  if (scored.length === 0) return { hits: [], mean: 0, std: 0 };

  let sum = 0;
  for (const s of scored) sum += s.score;
  const mean = sum / scored.length;
  let varSum = 0;
  for (const s of scored) varSum += (s.score - mean) ** 2;
  const std = Math.sqrt(varSum / scored.length);

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].score;
  const standsOut = (score: number) =>
    (std > 0 && (score - mean) / std >= CONFIDENT_Z) ||
    score - mean >= CONFIDENT_MARGIN;
  // The whisker only extends confidence from a best hit that is ITSELF
  // confident — otherwise a no-match query would always "find" something.
  const bestIsConfident = standsOut(best);

  const hits: SearchHit[] = scored.slice(0, topK).map((s) => ({
    ...s,
    confident:
      standsOut(s.score) || (bestIsConfident && best - s.score <= BEST_WHISKER),
  }));

  return { hits, mean, std };
}
