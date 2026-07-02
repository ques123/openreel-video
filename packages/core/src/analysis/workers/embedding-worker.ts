/**
 * Embedding worker: CLIP two-tower (Xenova/clip-vit-base-patch32) via
 * transformers.js. Embeds representative frames (RGBA pixels) and search
 * queries (text) into the same 512-d space. All vectors are L2-normalized
 * before leaving this worker, so cosine similarity = dot product.
 *
 * Device/dtype ladder: fp16(webgpu) -> fp32(webgpu) -> q8(wasm).
 * fp16 CLIP is known to produce NaNs on some GPUs; we validate the first
 * embedding and fall down the ladder if needed.
 */

import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor,
} from "@huggingface/transformers";
import { l2Normalize } from "../shot-metrics";
import type { InferenceDevice } from "../types";
import type { EmbedRequest, EmbedResponse } from "../worker-protocol";

const MODEL_ID = "Xenova/clip-vit-base-patch32";

function post(message: EmbedResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(message, { transfer: transfer ?? [] });
}

interface LoadedModels {
  tokenizer: PreTrainedTokenizer;
  processor: Processor;
  textModel: PreTrainedModel;
  visionModel: PreTrainedModel;
  device: InferenceDevice;
  dtype: string;
}

let models: LoadedModels | null = null;
let initPromise: Promise<LoadedModels> | null = null;

interface LadderStep {
  device: InferenceDevice;
  dtype: "fp16" | "fp32" | "q8";
}

function ladderFor(requested: "auto" | InferenceDevice): LadderStep[] {
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  if (requested === "wasm" || !hasWebGPU) return [{ device: "wasm", dtype: "q8" }];
  return [
    { device: "webgpu", dtype: "fp16" },
    { device: "webgpu", dtype: "fp32" },
    { device: "wasm", dtype: "q8" },
  ];
}

async function loadAt(step: LadderStep): Promise<LoadedModels> {
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

  const [tokenizer, processor, textModel, visionModel] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL_ID),
    AutoProcessor.from_pretrained(MODEL_ID, {}),
    CLIPTextModelWithProjection.from_pretrained(MODEL_ID, {
      device: step.device,
      dtype: step.dtype,
      progress_callback,
    }),
    CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
      device: step.device,
      dtype: step.dtype,
      progress_callback,
    }),
  ]);

  return {
    tokenizer,
    processor,
    textModel,
    visionModel,
    device: step.device,
    dtype: step.dtype,
  };
}

async function embedTextWith(m: LoadedModels, text: string): Promise<Float32Array> {
  const inputs = m.tokenizer([text], { padding: true, truncation: true });
  const output = (await m.textModel(inputs)) as { text_embeds: { data: Float32Array } };
  return l2Normalize(new Float32Array(output.text_embeds.data));
}

async function embedImageWith(
  m: LoadedModels,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Float32Array> {
  const image = new RawImage(rgba, width, height, 4);
  const inputs = await m.processor(image);
  const output = (await m.visionModel(inputs)) as { image_embeds: { data: Float32Array } };
  return l2Normalize(new Float32Array(output.image_embeds.data));
}

function isValid(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i += 1) {
    if (!Number.isFinite(v[i])) return false;
  }
  return true;
}

async function init(requested: "auto" | InferenceDevice): Promise<LoadedModels> {
  const startMs = performance.now();
  const ladder = ladderFor(requested);
  let lastError: unknown = null;

  for (const step of ladder) {
    try {
      const candidate = await loadAt(step);
      // Smoke-test: fp16 NaN hazard shows up immediately in a text embed.
      const probe = await embedTextWith(candidate, "a photo of a beach");
      if (!isValid(probe)) {
        throw new Error(`invalid embeddings at ${step.device}/${step.dtype}`);
      }
      models = candidate;
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

function ensureInit(requested: "auto" | InferenceDevice): Promise<LoadedModels> {
  if (!initPromise) {
    initPromise = init(requested).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

self.onmessage = (event: MessageEvent<EmbedRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    ensureInit(msg.device).catch((err) => {
      post({ type: "error", requestId: null, message: err.message ?? String(err) });
    });
    return;
  }

  void (async () => {
    try {
      const m = models ?? (await ensureInit("auto"));
      const startMs = performance.now();
      let vector: Float32Array;
      if (msg.type === "embed-text") {
        vector = await embedTextWith(m, msg.text);
      } else {
        vector = await embedImageWith(
          m,
          new Uint8ClampedArray(msg.pixels.data),
          msg.pixels.width,
          msg.pixels.height,
        );
      }
      const buffer = vector.buffer as ArrayBuffer;
      post(
        { type: "embedding", requestId: msg.requestId, vector: buffer, ms: performance.now() - startMs },
        [buffer],
      );
    } catch (err) {
      post({
        type: "error",
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
