import { providerForModel } from "./openai-proxy";

/**
 * Hardcoded USD-per-1M-token pricing for the cloud models this app calls
 * (director LLM + cloud captioning). Approximate, hand-entered 2026-07 list
 * prices — update by hand when prices change; never invented/guessed for a
 * model not listed here (estimateCostUSD returns null instead).
 *
 * Local captioning/whisper/CLIP inference runs in-browser and costs $0 —
 * never attach a cost estimate to local compute.
 *
 * IMPORTANT for OpenRouter model ids (contain "/"): OpenRouter routes a
 * single model id across several upstream providers at DIFFERENT prices —
 * these numbers are the CHEAPEST provider's floor rate, not a guaranteed
 * bill. A 91-clip qwen3-vl-235b run once displayed "≈$0.11" from this floor
 * rate while OpenRouter actually billed ~$0.20 (mostly served at a pricier
 * provider's $1.90/MTok output rate vs the $0.88 floor listed below). Treat
 * a token×rate estimate for an OpenRouter model as a LOWER BOUND, never the
 * expected cost — see costCellFor, which tildes exactly these estimates.
 * OpenAI bills the single fixed rate listed here, so its estimate is exact.
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

/** Display text/tooltip for a $ cell that is a known, exact billed cost. */
export const ACTUAL_COST_TITLE = "billed cost reported by the provider";

/**
 * Title for a token×rate estimate on an OpenRouter model: the listed rate is
 * only the cheapest available provider's floor (see MODEL_PRICING's header
 * comment) — the real bill can land higher.
 */
export const OPENROUTER_ESTIMATE_TITLE =
  "estimated at the model's listed floor rate — OpenRouter can route this call to a " +
  "pricier provider, so the actual bill can be higher than this estimate";

/** Title for the coarse pre-tracking estimate (early runs recorded no tokens at all). */
export const PRE_TRACKING_ESTIMATE_TITLE =
  "estimated from frame count — tokens were not recorded for early runs";

/** One $ cell's rendered text/title/emphasis, provider- and completeness-aware. */
export interface CostCell {
  text: string;
  title: string | undefined;
  /** True for every non-exact ("~"-prefixed) cell. */
  estimated: boolean;
}

/**
 * The $ cell for a cost row that may carry an exact provider-billed cost
 * (CloudRunMeta.actualCostUSD / ChatUsage.costUSD), an estimate from
 * measured tokens, or an estimate from a backfilled per-frame rate
 * (`isPreTrackingEstimate` — legacy runs recorded before usage tracking
 * shipped at all; see PerfPanel's derivation). Exactly four outcomes:
 *
 *  1. `actualCostUSD` is known (and this isn't a pre-tracking row) -> plain
 *     "$X.XX", ACTUAL_COST_TITLE. This is the ONLY exact-cost path.
 *  2. No estimate available either -> "—".
 *  3. `isPreTrackingEstimate` -> always "~$X.XX" (regardless of provider —
 *     unchanged from before actual-cost tracking existed).
 *  4. Otherwise (a real token×rate estimate, actual cost unknown): OpenRouter
 *     models get "~$X.XX" + OPENROUTER_ESTIMATE_TITLE (the $0.11-vs-$0.20
 *     trap this whole mechanism exists to surface); OpenAI models stay a
 *     plain "$X.XX" with no tilde — single provider, token×rate IS the
 *     exact bill, so today's behavior is already correct there.
 */
export function costCellFor(
  model: string,
  actualCostUSD: number | null,
  estimateUSD: number | null,
  isPreTrackingEstimate: boolean,
): CostCell {
  if (!isPreTrackingEstimate && actualCostUSD !== null) {
    return { text: fmtUSD(actualCostUSD), title: ACTUAL_COST_TITLE, estimated: false };
  }
  if (estimateUSD === null) return { text: "—", title: undefined, estimated: false };
  if (isPreTrackingEstimate) {
    return { text: `~${fmtUSD(estimateUSD)}`, title: PRE_TRACKING_ESTIMATE_TITLE, estimated: true };
  }
  if (providerForModel(model) === "OpenRouter") {
    return { text: `~${fmtUSD(estimateUSD)}`, title: OPENROUTER_ESTIMATE_TITLE, estimated: true };
  }
  return { text: fmtUSD(estimateUSD), title: undefined, estimated: false };
}
