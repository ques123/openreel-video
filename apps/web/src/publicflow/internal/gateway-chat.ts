/**
 * Director-loop chat completion via services/gateway.ts's `gatewayFetch`
 * rather than services/openai-proxy.ts's `chatComplete`. Both send the same
 * request shape (model routing, OpenRouter's usage:{include:true} opt-in,
 * the x-wizz-category header) and both already ride the metered gateway
 * paths — the difference is entirely in FAILURE shape:
 *
 * - chatComplete is deliberately hand-rolled (docs/wizz-contracts.md §4: "the
 *   four existing proxy call sites keep their own hand-rolled fetch + error-
 *   mapping — existing tests enforce it") and throws a plain `Error` whose
 *   message folds the raw status + response body together
 *   (`` `${provider} ${status}: ${body}` ``) — the admin lab's use-director.ts
 *   copes with this by substring-matching the message (see friendlyError
 *   there), which is fine for its purposes but throws away the structured
 *   WizzApiError envelope (code/category/resetsAt/retryAfterS) the public
 *   director needs for contracts §7's error-phase mapping.
 * - gatewayFetch already parses that envelope into a typed `GatewayError`.
 *
 * `packages/core`'s `runDirectorLoop` wraps ANY thrown error from its
 * `complete` dependency into a `DirectorLoopError` that keeps only
 * `err.message` (a string) — not the original error object — so a
 * GatewayError's structured fields would be lost by the time they reach
 * use-public-director.ts's catch block. `encodeGatewayError`/
 * `decodeGatewayError` round-trip those fields through that string
 * losslessly (a small tagged-JSON envelope) instead of trying to regex-parse
 * chatComplete's free-form provider/body text. See internal/
 * gateway-error-mapping.ts for the decode side.
 */
import type { AssistantTurn, ChatMessage, ToolDef } from "@openreel/core";
import { WIZZ_CATEGORY_HEADER, type UsageCategory } from "@wizz/contracts";
import {
  apiBaseForModel,
  parseChatUsage,
  type ChatUsage,
  type RawChatUsage,
} from "../../services/openai-proxy";
import { gatewayFetch, GatewayError } from "../../services/gateway";

const CATEGORY: UsageCategory = "director";

/** Tag prefixing the JSON-encoded GatewayError envelope inside a plain Error's message. */
export const GATEWAY_ERROR_MARKER = "GATEWAY_ERROR:";

/** Losslessly encodes a GatewayError's structured fields into an Error message string that survives DirectorLoopError's message-only wrapping. */
export function encodeGatewayError(err: GatewayError): string {
  return (
    GATEWAY_ERROR_MARKER +
    JSON.stringify({
      code: err.code,
      status: err.status,
      category: err.category ?? null,
      resetsAt: err.resetsAt ?? null,
      retryAfterS: err.retryAfterS ?? null,
      message: err.message,
    })
  );
}

export interface GatewayChatCompleteRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: { type: "function"; function: { name: string } };
}

interface GatewayChatResponse {
  choices?: { message?: AssistantTurn }[];
  usage?: RawChatUsage;
}

/**
 * Same request shaping as openai-proxy.ts's chatComplete (model-based
 * provider routing, OpenRouter-only usage:{include:true}), but transported
 * via gatewayFetch so failures carry a real WizzErrorCode. On a GatewayError,
 * re-throws a plain Error whose message is the encoded envelope (see above)
 * — callers (use-public-director.ts) decode it via
 * internal/gateway-error-mapping.ts after runDirectorLoop's wrapping.
 */
export async function completeViaGateway(
  req: GatewayChatCompleteRequest,
  signal: AbortSignal | undefined,
  onUsage: ((usage: ChatUsage) => void) | undefined,
): Promise<AssistantTurn> {
  const requestBody = req.model.includes("/") ? { ...req, usage: { include: true } } : req;
  let data: GatewayChatResponse;
  try {
    data = await gatewayFetch<GatewayChatResponse>(`${apiBaseForModel(req.model)}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [WIZZ_CATEGORY_HEADER]: CATEGORY },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (err) {
    if (err instanceof GatewayError) throw new Error(encodeGatewayError(err));
    throw err;
  }
  const usage = parseChatUsage(data.usage);
  if (usage && onUsage) onUsage(usage);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("director: response had no message");
  return message;
}
