/**
 * Minimal OpenAI client for the director. All calls go to the SAME-ORIGIN
 * path /api/proxy/openai/* — nginx on abacus injects the API key server-side
 * (dev: vite proxies the path to the deployed nginx over the tailnet), so no
 * key ever exists in the browser. Deliberately independent from api-proxy.ts
 * and the secure-storage BYO-key machinery used by the editor's AI features.
 */

import type { AssistantTurn, ChatMessage, ToolDef } from "@openreel/core";

/** Confirmed available through the abacus proxy (GET /models). */
export const DIRECTOR_MODEL = "gpt-5.2";

/**
 * Director models selectable from the UI (lever 8). OpenAI ids are bare;
 * OpenRouter ids carry a provider prefix ("qwen/...") — the slash is what
 * routes a call to the OpenRouter proxy path.
 */
export const DIRECTOR_MODELS = [
  "gpt-5.2",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "qwen/qwen3.7-max",
] as const;

export const BASE = "/api/proxy/openai";
export const OPENROUTER_BASE = "/api/proxy/openrouter";

/**
 * Same-origin proxy base for a model id: provider-prefixed ids
 * ("qwen/qwen3-vl-...") go to the OpenRouter passthrough, bare ids to the
 * OpenAI one. Both nginx locations inject their keys server-side.
 */
export function apiBaseForModel(model: string): string {
  return model.includes("/") ? OPENROUTER_BASE : BASE;
}

/** Provider name for error messages, by the same routing rule. */
export function providerForModel(model: string): "OpenAI" | "OpenRouter" {
  return model.includes("/") ? "OpenRouter" : "OpenAI";
}

/** "qwen/qwen3-vl-235b-a22b-instruct" -> "qwen3-vl-235b-a22b-instruct", "gpt-5.2" -> "5.2". */
export function shortModelLabel(model: string): string {
  return (model.split("/").pop() ?? model).replace("gpt-", "");
}

export interface ChatCompleteRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: { type: "function"; function: { name: string } };
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export async function chatComplete(
  req: ChatCompleteRequest,
  signal?: AbortSignal,
  onUsage?: (usage: ChatUsage) => void,
): Promise<AssistantTurn> {
  const res = await fetch(`${apiBaseForModel(req.model)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${providerForModel(req.model)} ${res.status}: ${body.slice(0, 300)}`);
  }
  // An unproxied path falls through to the SPA and returns 200 text/html —
  // catch that before json() turns it into a cryptic SyntaxError.
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new Error(
      `${providerForModel(req.model)} proxy route is not set up on the server ` +
        `(got HTML instead of JSON) — run docs/openrouter-proxy/apply-openrouter-proxy.sh on abacus`,
    );
  }
  const data = (await res.json()) as {
    choices?: { message?: AssistantTurn }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (data.usage && onUsage) {
    onUsage({
      promptTokens: data.usage.prompt_tokens ?? 0,
      completionTokens: data.usage.completion_tokens ?? 0,
    });
  }
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI response had no message");
  return message;
}

export async function listModels(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${BASE}/models`, { signal });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}
