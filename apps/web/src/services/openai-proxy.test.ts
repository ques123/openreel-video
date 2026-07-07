/**
 * openai-proxy request/response shaping: parseChatUsage's cost mapping (the
 * OpenRouter `usage.cost` field — see ChatUsage.costUSD's doc comment) and
 * chatComplete's provider-conditional `usage: {include: true}` body
 * injection (OpenRouter only; OpenAI's API rejects an unrecognized `usage`
 * request param).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { chatComplete, parseChatUsage, type ChatCompleteRequest } from "./openai-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseChatUsage", () => {
  it("returns null when the API omitted usage entirely", () => {
    expect(parseChatUsage(undefined)).toBeNull();
  });

  it("defaults missing token fields to 0 and costUSD to null when cost is absent", () => {
    expect(parseChatUsage({})).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUSD: null,
    });
  });

  it("maps prompt/completion/cached tokens and a present numeric cost", () => {
    const usage = parseChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 300 },
      cost: 6.312e-5,
    });
    expect(usage).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 300,
      costUSD: 6.312e-5,
    });
  });

  it("coerces non-finite cost values (NaN, Infinity) to null rather than passing them through", () => {
    expect(parseChatUsage({ cost: NaN })?.costUSD).toBeNull();
    expect(parseChatUsage({ cost: Infinity })?.costUSD).toBeNull();
    expect(parseChatUsage({ cost: -Infinity })?.costUSD).toBeNull();
  });

  it("treats an explicit cost of exactly 0 as a known (real) cost, not 'unknown'", () => {
    expect(parseChatUsage({ cost: 0 })?.costUSD).toBe(0);
  });
});

interface SentRequest {
  url: string;
  body: ChatCompleteRequest & { usage?: { include: boolean }; provider?: unknown };
}

function stubFetch(usage?: Record<string, unknown>): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      sent.push({ url, body: JSON.parse(init.body ?? "{}") });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "hi" } }],
          ...(usage ? { usage } : {}),
        }),
        text: async () => "",
      };
    }),
  );
  return sent;
}

describe("chatComplete request shaping", () => {
  it("does NOT add usage.include for an OpenAI (bare) model id", async () => {
    const sent = stubFetch();
    const req: ChatCompleteRequest = { model: "gpt-5.2", messages: [{ role: "user", content: "hi" }] };
    await chatComplete(req);
    expect(sent[0].url).toContain("/api/proxy/openai/");
    expect(sent[0].body.usage).toBeUndefined();
    expect(sent[0].body.provider).toBeUndefined();
  });

  it("adds usage.include (but no provider.sort) for an OpenRouter (slash) model id", async () => {
    const sent = stubFetch();
    const req: ChatCompleteRequest = {
      model: "qwen/qwen3.7-max",
      messages: [{ role: "user", content: "hi" }],
    };
    await chatComplete(req);
    expect(sent[0].url).toContain("/api/proxy/openrouter/");
    expect(sent[0].body.usage).toEqual({ include: true });
    // Director calls are interactive/latency-sensitive — no price-first
    // routing here (unlike cloud-vision.ts's withOpenRouterAccounting).
    expect(sent[0].body.provider).toBeUndefined();
  });

  it("never mutates the caller's request object", async () => {
    stubFetch();
    const req: ChatCompleteRequest = {
      model: "qwen/qwen3.7-max",
      messages: [{ role: "user", content: "hi" }],
    };
    await chatComplete(req);
    expect(req).not.toHaveProperty("usage");
  });

  it("passes the response's costUSD through to onUsage", async () => {
    stubFetch({ prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 });
    const req: ChatCompleteRequest = {
      model: "qwen/qwen3.7-max",
      messages: [{ role: "user", content: "hi" }],
    };
    const onUsage = vi.fn();
    await chatComplete(req, undefined, onUsage);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 10, completionTokens: 5, costUSD: 0.0012 }),
    );
  });

  it("reports costUSD: null for an OpenAI response (never billed via this field)", async () => {
    stubFetch({ prompt_tokens: 10, completion_tokens: 5 });
    const req: ChatCompleteRequest = { model: "gpt-5.2", messages: [{ role: "user", content: "hi" }] };
    const onUsage = vi.fn();
    await chatComplete(req, undefined, onUsage);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ costUSD: null }));
  });
});
