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

export const BASE = "/api/proxy/openai";

export interface ChatCompleteRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: { type: "function"; function: { name: string } };
}

export async function chatComplete(
  req: ChatCompleteRequest,
  signal?: AbortSignal,
): Promise<AssistantTurn> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: AssistantTurn }[];
  };
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
