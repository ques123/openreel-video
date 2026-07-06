/**
 * Hardcoded USD-per-1M-token pricing for the cloud models this app calls
 * (director LLM + cloud captioning). Approximate, hand-entered 2026-07 list
 * prices — update by hand when prices change; never invented/guessed for a
 * model not listed here (estimateCostUSD returns null instead).
 *
 * Local captioning/whisper/CLIP inference runs in-browser and costs $0 —
 * never attach a cost estimate to local compute.
 */
export const MODEL_PRICING: Record<string, { inPerMTok: number; outPerMTok: number }> = {
  "gpt-5.2": { inPerMTok: 1.75, outPerMTok: 14 },
  "gpt-5.4-mini": { inPerMTok: 0.75, outPerMTok: 4.5 },
  "gpt-5.4-nano": { inPerMTok: 0.2, outPerMTok: 1.25 },
  // OpenRouter list prices, 2026-07-06 (openrouter.ai/api/v1/models).
  "qwen/qwen3.7-max": { inPerMTok: 1.25, outPerMTok: 3.75 },
  "qwen/qwen3-vl-235b-a22b-instruct": { inPerMTok: 0.2, outPerMTok: 0.88 },
  "qwen/qwen3-vl-30b-a3b-instruct": { inPerMTok: 0.13, outPerMTok: 0.52 },
};

/** USD cost for a token count against a known model; null for unknown models — never guess. */
export function estimateCostUSD(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = MODEL_PRICING[model];
  if (!price) return null;
  return (promptTokens * price.inPerMTok + completionTokens * price.outPerMTok) / 1e6;
}

/** 0.55 -> "$0.55", 0.001 -> "<$0.01", 1.5625 -> "$1.56". */
export function fmtUSD(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
