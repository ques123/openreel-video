/**
 * Caption worker: FastVLM-0.5B (onnx-community/FastVLM-0.5B-ONNX) via
 * transformers.js. Writes an editor-framed scene description for a frame so
 * the director can READ the footage instead of discovering it query-by-query
 * through embedding search.
 *
 * FastVLM replaced Florence-2 after a head-to-head on real footage
 * (2026-07-03): it is promptable (subject/action/mood/quality in one ask),
 * identifies specifics Florence missed (durian, blur ruining a shot), and
 * writes coherent prose instead of annotation fragments, at ~2x the
 * per-frame cost. This worker is deliberately the ONLY model-specific file
 * in the caption path.
 *
 * Runs on the dense frames / thumbnails already stored in dossiers — no
 * video decode, which is what lets cached dossiers be enriched in place.
 *
 * Device ladder: webgpu (fp16 embeddings / q4 vision+decoder, per the model
 * card) -> wasm q8. Generation is heavy; the orchestrator serializes requests.
 */

import {
  AutoModelForImageTextToText,
  AutoProcessor,
  RawImage,
  type PreTrainedModel,
  type Processor,
  type Tensor,
} from "@huggingface/transformers";
import type { InferenceDevice } from "../types";
import type { CaptionWorkerRequest, CaptionWorkerResponse } from "../worker-protocol";

const MODEL_ID = "onnx-community/FastVLM-0.5B-ONNX";
const PROMPT =
  "Describe this video frame for an editor choosing shots: subject, action, " +
  "setting, mood, and anything visually striking or wrong (blur, bad framing). " +
  "2-3 short sentences.";
const MAX_NEW_TOKENS = 110;

function post(message: CaptionWorkerResponse) {
  (self as unknown as Worker).postMessage(message);
}

interface Loaded {
  model: PreTrainedModel;
  processor: Processor;
  device: InferenceDevice;
  dtype: string;
}

let loaded: Loaded | null = null;
let initPromise: Promise<Loaded> | null = null;

interface LadderStep {
  device: InferenceDevice;
  dtype: string | Record<string, string>;
  label: string;
}

function ladderFor(requested: "auto" | InferenceDevice): LadderStep[] {
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  const wasmStep: LadderStep = { device: "wasm", dtype: "q8", label: "q8" };
  if (requested === "wasm" || !hasWebGPU) return [wasmStep];
  return [
    {
      device: "webgpu",
      dtype: {
        embed_tokens: "fp16",
        vision_encoder: "q4",
        decoder_model_merged: "q4",
      },
      label: "fp16/q4",
    },
    wasmStep,
  ];
}

async function loadAt(step: LadderStep): Promise<Loaded> {
  const progress_callback = (p: unknown) => {
    const info = p as { status?: string; file?: string; loaded?: number; total?: number };
    if (info.status === "progress" && info.file) {
      post({
        type: "model-progress",
        file: info.file,
        loaded: info.loaded ?? 0,
        total: info.total ?? 0,
      });
    }
  };

  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID, {}),
    AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
      device: step.device,
      dtype: step.dtype as never,
      progress_callback,
    }),
  ]);

  return { model, processor, device: step.device, dtype: step.label };
}

async function captionWith(m: Loaded, imageUrl: string): Promise<string> {
  const image = await RawImage.fromURL(imageUrl);

  const chat = m.processor as Processor & {
    apply_chat_template(messages: object[], opts: object): string;
    batch_decode(t: Tensor, o: object): string[];
  };
  const prompt = chat.apply_chat_template(
    [{ role: "user", content: `<image>${PROMPT}` }],
    { add_generation_prompt: true },
  );
  const inputs = await m.processor(image, prompt, { add_special_tokens: false });

  const outputs = (await (
    m.model as PreTrainedModel & { generate(opts: object): Promise<Tensor> }
  ).generate({
    ...inputs,
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: false,
  })) as Tensor & { slice(...args: unknown[]): Tensor };

  // Decode only the newly generated tokens (drop the prompt prefix).
  const promptLength = (inputs.input_ids as Tensor & { dims: number[] }).dims.at(-1);
  const generated = outputs.slice(null, [promptLength, null]);
  return chat.batch_decode(generated, { skip_special_tokens: true })[0].trim();
}

async function init(requested: "auto" | InferenceDevice): Promise<Loaded> {
  const startMs = performance.now();
  let lastError: unknown = null;

  for (const step of ladderFor(requested)) {
    try {
      const candidate = await loadAt(step);
      loaded = candidate;
      post({
        type: "ready",
        device: candidate.device,
        dtype: candidate.dtype,
        loadMs: performance.now() - startMs,
      });
      return candidate;
    } catch (err) {
      lastError = err;
      // fall through to the next ladder step
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function ensureInit(requested: "auto" | InferenceDevice): Promise<Loaded> {
  if (!initPromise) {
    initPromise = init(requested).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

self.onmessage = (event: MessageEvent<CaptionWorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    ensureInit(msg.device).catch((err) => {
      post({ type: "error", requestId: null, message: err.message ?? String(err) });
    });
    return;
  }

  void (async () => {
    try {
      const m = loaded ?? (await ensureInit("auto"));
      const startMs = performance.now();
      const caption = await captionWith(m, msg.image);
      post({
        type: "caption",
        requestId: msg.requestId,
        caption,
        ms: performance.now() - startMs,
      });
    } catch (err) {
      post({
        type: "error",
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
