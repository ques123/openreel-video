/**
 * Caption worker: Florence-2 (onnx-community/Florence-2-base-ft) via
 * transformers.js. Writes a plain-English scene description for a shot's
 * representative frame so the director can READ the footage instead of
 * discovering it query-by-query through CLIP search.
 *
 * Runs on the shot thumbnails already stored in dossiers — no video decode,
 * which is what lets cached (pre-caption) dossiers be enriched in place.
 *
 * Device ladder: webgpu (fp16 vision / q4 text, per the transformers.js
 * guidance that encoder-decoder models are quantization-sensitive) -> wasm q8.
 * Generation is heavy; the orchestrator serializes requests.
 */

import {
  AutoProcessor,
  AutoTokenizer,
  Florence2ForConditionalGeneration,
  RawImage,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor,
  type Tensor,
} from "@huggingface/transformers";
import type { InferenceDevice } from "../types";
import type { CaptionWorkerRequest, CaptionWorkerResponse } from "../worker-protocol";

const MODEL_ID = "onnx-community/Florence-2-base-ft";
const TASK = "<DETAILED_CAPTION>";
const MAX_NEW_TOKENS = 128;

function post(message: CaptionWorkerResponse) {
  (self as unknown as Worker).postMessage(message);
}

interface Loaded {
  model: PreTrainedModel;
  processor: Processor;
  tokenizer: PreTrainedTokenizer;
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
        vision_encoder: "fp16",
        encoder_model: "q4",
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

  const [model, processor, tokenizer] = await Promise.all([
    Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
      device: step.device,
      dtype: step.dtype as never,
      progress_callback,
    }),
    AutoProcessor.from_pretrained(MODEL_ID, {}),
    AutoTokenizer.from_pretrained(MODEL_ID),
  ]);

  return { model, processor, tokenizer, device: step.device, dtype: step.label };
}

async function captionWith(m: Loaded, imageUrl: string): Promise<string> {
  const image = await RawImage.fromURL(imageUrl);

  const florence = m.processor as Processor & {
    construct_prompts(task: string): string[];
    post_process_generation(
      text: string,
      task: string,
      size: [number, number],
    ): Record<string, string>;
  };
  const prompts = florence.construct_prompts(TASK);
  const textInputs = m.tokenizer(prompts);
  const visionInputs = await m.processor(image);

  const generatedIds = (await (
    m.model as PreTrainedModel & { generate(opts: object): Promise<Tensor> }
  ).generate({
    ...textInputs,
    ...visionInputs,
    max_new_tokens: MAX_NEW_TOKENS,
  })) as Tensor;

  const generatedText = m.tokenizer.batch_decode(generatedIds, {
    skip_special_tokens: false,
  })[0];
  const result = florence.post_process_generation(generatedText, TASK, image.size);
  return (result[TASK] ?? "").trim();
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
