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
import { apiBaseForModel, DIRECTOR_MODEL } from "./openai-proxy";

const BATCH_SIZE = 8;
/** Concurrent batch requests: ~6x wall-clock at identical cost. */
const CONCURRENCY = 5;

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

interface BatchResult {
  captions: DenseCaption[];
  promptTokens: number;
  completionTokens: number;
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

  const res = await fetch(`${apiBaseForModel(model)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
    }),
    signal,
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
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(raw) as { captions?: { i?: number; text?: string }[] };
  const out: DenseCaption[] = [];
  for (const c of parsed.captions ?? []) {
    const idx = (c.i ?? 0) - 1;
    if (idx >= 0 && idx < frames.length && c.text?.trim()) {
      out.push({ t: frames[idx].t, text: c.text.trim() });
    }
  }
  if (out.length === 0) throw new Error("cloud vision returned no captions");
  return {
    captions: out,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

export interface CloudVisionRun {
  captions: DenseCaption[];
  framesSent: number;
  framesFailed: number;
  model: string;
  /** Wall-clock for the whole run. */
  ms: number;
  /** Real usage summed across batches (0 when the API omits it). */
  promptTokens: number;
  completionTokens: number;
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
  let framesDone = 0;
  const absorb = (b: BatchResult) => {
    captions.push(...b.captions);
    promptTokens += b.promptTokens;
    completionTokens += b.completionTokens;
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
        try {
          absorb(await describeBatch(batch, model, signal)); // one retry
        } catch {
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
  };
}
