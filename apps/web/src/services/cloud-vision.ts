/**
 * Opt-in cloud vision pass: sends selected frames (512px JPEGs from the
 * dossier) through the same-origin OpenAI proxy and returns editor-grade
 * timestamped descriptions. THIS IS THE ONLY PLACE PIXELS LEAVE THE DEVICE,
 * and only when the user explicitly enables cloud vision and clicks Enhance.
 *
 * Frames go in batches; each batch is one chat completion with N images and
 * a strict-JSON reply. Batches are sequential (proxy-friendly) and
 * best-effort: a failed batch is retried once, then skipped.
 */

import type { CloudFrame, DenseCaption } from "@openreel/core";
import {
  apiBaseForModel,
  DIRECTOR_MODEL,
  parseChatUsage,
  providerForModel,
  type RawChatUsage,
} from "./openai-proxy";

const BATCH_SIZE = 16;
/** Concurrent batch requests: ~6x wall-clock at identical cost. */
const CONCURRENCY = 5;

/**
 * Per-request watchdog: without one, a single stalled request parks a worker
 * loop forever and the bulk Promise.all never resolves. Scaled to batch size
 * (completion length grows with frame count); an expired timer aborts the
 * fetch, which the worker treats as a normal retryable failure. 16 frames ->
 * ~62s, comfortably above a slow-but-live batch, far below "hung".
 */
const BATCH_TIMEOUT_BASE_MS = 30_000;
const BATCH_TIMEOUT_PER_FRAME_MS = 2_000;

/**
 * Completion budget per frame: a caption is 1-3 sentences (~60-80 tokens)
 * plus JSON overhead, so 200 leaves ~2.5x headroom while bounding a runaway
 * response (a model stuck repeating itself) at batch scale.
 */
const MAX_COMPLETION_TOKENS_PER_FRAME = 200;

/**
 * Caption-capable models offered in the UI. Bare ids run through the OpenAI
 * proxy; "qwen/..." ids through the OpenRouter proxy (both same-origin,
 * keys injected server-side). The Qwen3-VL pair is the open-weights
 * cost/quality ladder: 235B ≈ frontier quality at ~1/5 the price of
 * gpt-5.4-mini's output rate; 30B-A3B is the budget tier.
 */
export const CAPTION_MODELS = [
  "gpt-5.2",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "qwen/qwen3-vl-235b-a22b-instruct",
  "qwen/qwen3-vl-30b-a3b-instruct",
] as const;
export type CaptionModel = (typeof CAPTION_MODELS)[number];

const INSTRUCTIONS =
  "You describe frames from raw video footage for a video editor choosing shots. " +
  "For EACH image, in order, write 1-3 sentences: subject, action, setting, mood, " +
  "composition, and anything that makes the moment usable or unusable (blur, bad " +
  "framing, dead moment, great light, genuine emotion). Be specific and concrete. " +
  "Some frames represent a visually static span (noted with their timestamp); " +
  "describe the frame as usual — the description applies to the whole span. " +
  'Reply with STRICT JSON: {"captions":[{"i":<image number starting at 1>,"text":"..."}]} ' +
  "with exactly one entry per image.";

interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail: "low" | "high" };
}

interface BatchUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /**
   * Exact USD billed for this attempt; null when the provider didn't report
   * one (see ChatUsage.costUSD). Optional (not just nullable), matching
   * ChatUsage.costUSD's optionality, so a ChatUsage from parseChatUsage
   * structurally satisfies this type without a cast; always read via
   * `?? null` since the field itself may be entirely absent.
   */
  costUSD?: number | null;
}

/**
 * OpenRouter-only additions to a captioning request body: `usage.include`
 * captures the exact billed cost (see ChatUsage.costUSD/BatchUsage.costUSD),
 * and `provider.sort: "price"` prefers the cheapest available provider —
 * fallbacks still apply on errors/rate limits, so this never sacrifices
 * availability for price. Captions are the batch cost center (unlike the
 * director's interactive chatComplete calls in openai-proxy.ts, which skip
 * provider.sort), so price-first routing is the right default here. OpenAI
 * models are returned untouched: its API has no `usage`/`provider` request
 * params. Exported as a small pure function so the body-shaping is directly
 * unit-testable without a network stub.
 */
export function withOpenRouterAccounting(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (providerForModel(model) !== "OpenRouter") return body;
  return { ...body, usage: { include: true }, provider: { sort: "price" } };
}

/**
 * actualCostUSD for a run: the sum of every usage-bearing batch's billed
 * cost (see BatchUsage.costUSD), but ONLY when every one of them reported a
 * cost — a single unreported cost makes the total untrustworthy (the caller
 * must fall back to the token×rate estimate instead of silently understating
 * spend), so this returns null rather than a partial sum. Empty input (no
 * usage-bearing batch at all) is the same "unknown" case, hence also null.
 *
 * Batches that failed BOTH attempts with NO usage at all (a genuine timeout/
 * abort — see the worker loop in describeFramesCloud) never appear in
 * `costs`: they are inherently unknowable, not just unreported, so they
 * can't be allowed to poison completeness for the batches that DID report.
 * Because something may still have been billed for them server-side, the
 * true bill can only be HIGHER than whatever this returns — never lower.
 */
export function aggregateActualCostUSD(costs: Array<number | null>): number | null {
  if (costs.length === 0) return null;
  let sum = 0;
  for (const cost of costs) {
    if (cost === null) return null;
    sum += cost;
  }
  return sum;
}

interface BatchResult extends BatchUsage {
  captions: DenseCaption[];
}

/**
 * A batch whose reply was unusable (invalid/strict-JSON miss, zero captions)
 * AFTER the provider billed it: carries the real usage so a retried/skipped
 * batch still lands in cost accounting instead of being double-billed with
 * zero recorded.
 */
class BatchFailedError extends Error {
  constructor(
    message: string,
    readonly usage: BatchUsage | null,
  ) {
    super(message);
    this.name = "BatchFailedError";
  }
}

async function describeBatch(
  frames: CloudFrame[],
  model: string,
  signal?: AbortSignal,
): Promise<BatchResult> {
  const header =
    `${INSTRUCTIONS}\n\nYou are given ${frames.length} frames. Frame timestamps (seconds): ` +
    frames
      .map((f, i) => {
        const span =
          f.t1 !== undefined ? ` (static span ${f.t.toFixed(1)}-${f.t1.toFixed(1)}s)` : "";
        return `#${i + 1}=${f.t.toFixed(1)}s${span}`;
      })
      .join(", ");
  const content: ContentPart[] = [
    { type: "text", text: header },
    ...frames.map(
      (f): ContentPart => ({
        type: "image_url",
        image_url: { url: f.dataUrl, detail: "low" },
      }),
    ),
  ];

  // Runaway-output guard, scaled to batch size. OpenAI's newer models accept
  // only max_completion_tokens; OpenRouter normalizes max_tokens for everyone.
  const maxTokens = frames.length * MAX_COMPLETION_TOKENS_PER_FRAME;
  const timeout = AbortSignal.timeout(
    BATCH_TIMEOUT_BASE_MS + frames.length * BATCH_TIMEOUT_PER_FRAME_MS,
  );
  const res = await fetch(`${apiBaseForModel(model)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      withOpenRouterAccounting(
        {
          model,
          messages: [{ role: "user", content }],
          response_format: { type: "json_object" },
          ...(model.includes("/")
            ? { max_tokens: maxTokens }
            : { max_completion_tokens: maxTokens }),
        },
        model,
      ),
    ),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`cloud vision ${res.status}: ${body.slice(0, 200)}`);
  }
  // An unproxied path falls through to the SPA and returns 200 text/html —
  // catch that before json() turns it into a cryptic SyntaxError.
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new Error(
      "cloud vision: proxy route is not set up on the server (got HTML instead " +
        "of JSON) — for qwen/* models run docs/openrouter-proxy/apply-openrouter-proxy.sh on abacus",
    );
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: RawChatUsage;
  };
  // The provider bills a batch even when its reply is unusable — capture
  // usage BEFORE any parse/validation throw so it survives the failure.
  const usage = parseChatUsage(data.usage);
  const raw = data.choices?.[0]?.message?.content ?? "";
  let parsed: { captions?: { i?: number; text?: string }[] };
  try {
    parsed = JSON.parse(raw) as { captions?: { i?: number; text?: string }[] };
  } catch {
    throw new BatchFailedError("cloud vision returned invalid JSON", usage);
  }
  const out: DenseCaption[] = [];
  for (const c of parsed.captions ?? []) {
    const idx = (c.i ?? 0) - 1;
    if (idx >= 0 && idx < frames.length && c.text?.trim()) {
      out.push({ t: frames[idx].t, text: c.text.trim() });
    }
  }
  if (out.length === 0) throw new BatchFailedError("cloud vision returned no captions", usage);
  return {
    captions: out,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    cachedTokens: usage?.cachedTokens ?? 0,
    costUSD: usage?.costUSD ?? null,
  };
}

export interface CloudVisionRun {
  captions: DenseCaption[];
  framesSent: number;
  framesFailed: number;
  model: string;
  /** Wall-clock for the whole run. */
  ms: number;
  /**
   * Real usage summed across batches (0 when the API omits it). INCLUDES
   * failed-then-retried/skipped batches whose response carried usage —
   * billed is billed, whether or not the captions were usable.
   */
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache (subset of promptTokens). */
  cachedTokens: number;
  /**
   * Exact USD billed for the run, summed across every usage-bearing batch —
   * null when that sum isn't fully known (some/all batches didn't report a
   * cost, e.g. an OpenAI caption model, or no batch reported usage at all).
   * See aggregateActualCostUSD. Callers MUST fall back to the token×rate
   * estimate when this is null rather than treating it as $0.
   */
  actualCostUSD: number | null;
}

export async function describeFramesCloud(
  frames: CloudFrame[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  model: string = DIRECTOR_MODEL,
): Promise<CloudVisionRun> {
  const startMs = performance.now();
  const captions: DenseCaption[] = [];
  let framesFailed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let framesDone = 0;
  /** One entry per usage-bearing batch attempt — see aggregateActualCostUSD. */
  const batchCosts: Array<number | null> = [];
  const absorbUsage = (u: BatchUsage) => {
    promptTokens += u.promptTokens;
    completionTokens += u.completionTokens;
    cachedTokens += u.cachedTokens;
    batchCosts.push(u.costUSD ?? null);
  };
  const absorb = (b: BatchResult) => {
    captions.push(...b.captions);
    absorbUsage(b);
  };
  /** A failed attempt that still carried usage was still billed — record it. */
  const absorbFailure = (err: unknown) => {
    if (err instanceof BatchFailedError && err.usage) absorbUsage(err.usage);
  };

  const batches: CloudFrame[][] = [];
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    batches.push(frames.slice(i, i + BATCH_SIZE));
  }

  // Batches run CONCURRENCY at a time (identical tokens, ~6x faster than
  // sequential); each keeps its own single retry.
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const batch = batches[next];
      next += 1;
      try {
        absorb(await describeBatch(batch, model, signal));
      } catch (err) {
        if (signal?.aborted) throw err;
        absorbFailure(err);
        try {
          absorb(await describeBatch(batch, model, signal)); // one retry
        } catch (retryErr) {
          absorbFailure(retryErr);
          framesFailed += batch.length;
        }
      }
      framesDone += batch.length;
      onProgress?.(Math.min(framesDone, frames.length), frames.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()),
  );

  if (captions.length === 0 && frames.length > 0) {
    throw new Error("cloud vision failed for every batch — is the proxy reachable?");
  }
  return {
    captions,
    framesSent: frames.length,
    framesFailed,
    model,
    ms: Math.round(performance.now() - startMs),
    promptTokens,
    completionTokens,
    cachedTokens,
    actualCostUSD: aggregateActualCostUSD(batchCosts),
  };
}
