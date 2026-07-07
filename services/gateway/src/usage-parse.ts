/**
 * Pure usage-parsing helpers — no I/O. Mirrors the client's cost-truth
 * semantics EXACTLY (apps/web/src/services/openai-proxy.ts's parseChatUsage,
 * groq-stt.ts's billedSecondsForChunk/costUSDForBilledSeconds) so a
 * provider's bill and the gateway's usage_events row always agree. Re-
 * implemented here rather than imported: the gateway is a separate node
 * package from apps/web's browser bundle (no workspace dependency wired, and
 * importing browser-target TS across that boundary would be the wrong
 * layering) — see the WS-B report for this call-out.
 */

/* ─────────────────────── openai / openrouter chat usage ─────────────────────── */

/** Wire-format usage block on a chat completion (OpenAI and OpenRouter) — same shape the client reads. */
export interface RawChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** USD actually billed; OpenRouter-only, present only when the request opted into `usage: {include: true}`. */
  cost?: number;
}

export interface ParsedChatUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** null = unknown (OpenAI never reports this field); never coerced to 0. */
  costUSD: number | null;
}

/** Normalizes a wire usage block; null when the API omitted usage entirely (e.g. an error body, a /models call). */
export function parseChatUsage(usage: RawChatUsage | undefined | null): ParsedChatUsage | null {
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    costUSD: typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null,
  };
}

/** Extracts the `model` field from a chat-completion request body, for the usage row (director/caption categories). */
export function extractRequestModel(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const model = (body as { model?: unknown }).model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

/**
 * Counts image parts (content arrays with type "image_url") across every
 * message in a chat-completion request body — the caption category's frame
 * count, known entirely from the request (no need to wait for a response).
 */
export function countImageParts(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "image_url") {
        count += 1;
      }
    }
  }
  return count;
}

/* ─────────────────────────────── groq stt ─────────────────────────────── */

/** Groq (like OpenAI) bills every transcription request as at least this many seconds. */
export const GROQ_MIN_BILLED_SECONDS = 10;

/** List price, 2026-07 (console.groq.com/pricing) — mirrors groq-stt.ts's GROQ_WHISPER_USD_PER_HOUR. */
export const GROQ_WHISPER_USD_PER_HOUR = 0.04;

/** Groq's per-request floor: a 3.2-second clip still bills as 10 seconds. */
export function groqBilledSeconds(durationS: number): number {
  return Math.max(durationS, GROQ_MIN_BILLED_SECONDS);
}

export function groqCostUSD(billedSeconds: number, ratePerHour: number = GROQ_WHISPER_USD_PER_HOUR): number {
  return (billedSeconds / 3600) * ratePerHour;
}

export interface RawGroqTranscription {
  duration?: number;
}

export interface ParsedGroqUsage {
  seconds: number;
  costUSD: number;
}

/**
 * Parses a Groq verbose_json transcription response into billed seconds +
 * cost. Only called on a successful (2xx, valid-JSON) response — an upstream
 * failure records null seconds/cost via the general "nothing to parse" path
 * in proxy.ts, since no transcription actually happened.
 */
export function parseGroqUsage(raw: RawGroqTranscription | undefined | null): ParsedGroqUsage {
  const duration =
    raw && typeof raw.duration === "number" && Number.isFinite(raw.duration) ? raw.duration : 0;
  const seconds = groqBilledSeconds(duration);
  return { seconds, costUSD: groqCostUSD(seconds) };
}

/* ──────────────────────────────── suno ──────────────────────────────── */

/** units=1 on an accepted POST generate; record-info polls never reach this (metered-free, see proxy.ts). */
export const SUNO_GENERATE_UNITS = 1;
