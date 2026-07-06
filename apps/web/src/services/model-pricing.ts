/**
 * Hardcoded USD-per-1M-token pricing for the cloud models this app calls
 * (director LLM + cloud captioning). Approximate, hand-entered 2026-07 list
 * prices — update by hand when prices change; never invented/guessed for a
 * model not listed here (estimateCostUSD returns null instead).
 *
 * Local captioning/whisper/CLIP inference runs in-browser and costs $0 —
 * never attach a cost estimate to local compute.
 */
export const MODEL_PRICING: Record<
  string,
  { inPerMTok: number; outPerMTok: number; cachedInPerMTok?: number }
> = {
  // OpenAI bills cached input at 10% of the input rate across the gpt-5 family.
  "gpt-5.2": { inPerMTok: 1.75, outPerMTok: 14, cachedInPerMTok: 0.175 },
  "gpt-5.4-mini": { inPerMTok: 0.75, outPerMTok: 4.5, cachedInPerMTok: 0.075 },
  "gpt-5.4-nano": { inPerMTok: 0.2, outPerMTok: 1.25, cachedInPerMTok: 0.02 },
  // OpenRouter list prices, 2026-07-06 (openrouter.ai/api/v1/models). Cached
  // input pricing there varies by upstream provider — unknown, so no
  // cachedInPerMTok: cached tokens are charged at the full input rate.
  "qwen/qwen3.7-max": { inPerMTok: 1.25, outPerMTok: 3.75 },
  "qwen/qwen3-vl-235b-a22b-instruct": { inPerMTok: 0.2, outPerMTok: 0.88 },
  "qwen/qwen3-vl-30b-a3b-instruct": { inPerMTok: 0.13, outPerMTok: 0.52 },
};

/**
 * USD cost for a token count against a known model; null for unknown models —
 * never guess. `cachedTokens` is the SUBSET of promptTokens served from the
 * provider's prompt cache; when the model has a known cached-input rate those
 * tokens get the discount, otherwise they cost the full input rate (so an
 * unknown cache price can never understate spend).
 */
export function estimateCostUSD(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number | null {
  const price = MODEL_PRICING[model];
  if (!price) return null;
  const cached = Math.min(Math.max(cachedTokens, 0), promptTokens);
  const cachedRate = price.cachedInPerMTok ?? price.inPerMTok;
  return (
    ((promptTokens - cached) * price.inPerMTok +
      cached * cachedRate +
      completionTokens * price.outPerMTok) /
    1e6
  );
}

/** 0.55 -> "$0.55", 0.001 -> "<$0.01", 1.5625 -> "$1.56". */
export function fmtUSD(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
