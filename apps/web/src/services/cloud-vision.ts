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

import type { DenseCaption, DenseFrame } from "@openreel/core";
import { BASE, DIRECTOR_MODEL } from "./openai-proxy";

const BATCH_SIZE = 8;

const INSTRUCTIONS =
  "You describe frames from raw video footage for a video editor choosing shots. " +
  "For EACH image, in order, write 1-3 sentences: subject, action, setting, mood, " +
  "composition, and anything that makes the moment usable or unusable (blur, bad " +
  "framing, dead moment, great light, genuine emotion). Be specific and concrete. " +
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
  frames: DenseFrame[],
  signal?: AbortSignal,
): Promise<BatchResult> {
  const header =
    `${INSTRUCTIONS}\n\nYou are given ${frames.length} frames. Frame timestamps (seconds): ` +
    frames.map((f, i) => `#${i + 1}=${f.t.toFixed(1)}s`).join(", ");
  const content: ContentPart[] = [
    { type: "text", text: header },
    ...frames.map(
      (f): ContentPart => ({
        type: "image_url",
        image_url: { url: f.dataUrl, detail: "low" },
      }),
    ),
  ];

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DIRECTOR_MODEL,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`cloud vision ${res.status}: ${body.slice(0, 200)}`);
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
  frames: DenseFrame[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<CloudVisionRun> {
  const startMs = performance.now();
  const captions: DenseCaption[] = [];
  let framesFailed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const absorb = (b: BatchResult) => {
    captions.push(...b.captions);
    promptTokens += b.promptTokens;
    completionTokens += b.completionTokens;
  };
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    const batch = frames.slice(i, i + BATCH_SIZE);
    try {
      absorb(await describeBatch(batch, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      try {
        absorb(await describeBatch(batch, signal)); // one retry
      } catch {
        framesFailed += batch.length;
      }
    }
    onProgress?.(Math.min(i + BATCH_SIZE, frames.length), frames.length);
  }
  if (captions.length === 0 && frames.length > 0) {
    throw new Error("cloud vision failed for every batch — is the proxy reachable?");
  }
  return {
    captions,
    framesSent: frames.length,
    framesFailed,
    model: DIRECTOR_MODEL,
    ms: Math.round(performance.now() - startMs),
    promptTokens,
    completionTokens,
  };
}
