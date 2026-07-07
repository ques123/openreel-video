/**
 * Fixtures adapted from apps/web/src/services/openai-proxy.test.ts
 * (parseChatUsage) and groq-stt.test.ts (billedSecondsForChunk /
 * costUSDForBilledSeconds) — the gateway's parsing must match those exactly.
 */
import { describe, expect, it } from "vitest";
import {
  countImageParts,
  extractRequestModel,
  GROQ_MIN_BILLED_SECONDS,
  GROQ_WHISPER_USD_PER_HOUR,
  groqBilledSeconds,
  groqCostUSD,
  parseChatUsage,
  parseGroqUsage,
  SUNO_GENERATE_UNITS,
} from "./usage-parse";

describe("parseChatUsage", () => {
  it("returns null when the API omitted usage entirely", () => {
    expect(parseChatUsage(undefined)).toBeNull();
    expect(parseChatUsage(null)).toBeNull();
  });

  it("defaults missing token fields to 0 and costUSD to null when cost is absent", () => {
    expect(parseChatUsage({})).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUSD: null,
    });
  });

  it("maps prompt/completion/cached tokens and a present numeric cost (openrouter usage.cost)", () => {
    const usage = parseChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 300 },
      cost: 6.312e-5,
    });
    expect(usage).toEqual({ promptTokens: 1000, completionTokens: 200, cachedTokens: 300, costUSD: 6.312e-5 });
  });

  it("coerces non-finite cost values (NaN, Infinity) to null rather than passing them through", () => {
    expect(parseChatUsage({ cost: NaN })?.costUSD).toBeNull();
    expect(parseChatUsage({ cost: Infinity })?.costUSD).toBeNull();
    expect(parseChatUsage({ cost: -Infinity })?.costUSD).toBeNull();
  });

  it("treats an explicit cost of exactly 0 as a known (real) cost, not 'unknown'", () => {
    expect(parseChatUsage({ cost: 0 })?.costUSD).toBe(0);
  });

  it("defaults cached_tokens to 0 when prompt_tokens_details is present but empty", () => {
    expect(parseChatUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: {} })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
      costUSD: null,
    });
  });
});

describe("extractRequestModel", () => {
  it("reads the model field from a chat-completion request body", () => {
    expect(extractRequestModel({ model: "gpt-5.4-mini", messages: [] })).toBe("gpt-5.4-mini");
  });

  it("returns null for a missing/non-string/empty model field", () => {
    expect(extractRequestModel({})).toBeNull();
    expect(extractRequestModel({ model: 123 })).toBeNull();
    expect(extractRequestModel({ model: "" })).toBeNull();
    expect(extractRequestModel(null)).toBeNull();
    expect(extractRequestModel("not an object")).toBeNull();
  });
});

describe("countImageParts", () => {
  it("counts image_url parts across content arrays, ignoring text parts", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:...", detail: "low" } },
            { type: "image_url", image_url: { url: "data:...", detail: "low" } },
          ],
        },
      ],
    };
    expect(countImageParts(body)).toBe(2);
  });

  it("sums across multiple messages", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: {} }] },
        { role: "user", content: [{ type: "image_url", image_url: {} }, { type: "image_url", image_url: {} }] },
      ],
    };
    expect(countImageParts(body)).toBe(3);
  });

  it("returns 0 when content is a plain string (no images) or messages is absent", () => {
    expect(countImageParts({ messages: [{ role: "user", content: "just text" }] })).toBe(0);
    expect(countImageParts({})).toBe(0);
    expect(countImageParts(null)).toBe(0);
    expect(countImageParts(undefined)).toBe(0);
  });
});

describe("groqBilledSeconds", () => {
  it("clamps chunks shorter than the 10s minimum up to 10 (3.2s bills as 10s)", () => {
    expect(groqBilledSeconds(3.2)).toBe(GROQ_MIN_BILLED_SECONDS);
    expect(groqBilledSeconds(0)).toBe(10);
  });

  it("passes through durations at/above the minimum unchanged (700s bills as 700s)", () => {
    expect(groqBilledSeconds(10)).toBe(10);
    expect(groqBilledSeconds(700)).toBe(700);
  });
});

describe("groqCostUSD", () => {
  it("prices a full hour at the list rate", () => {
    expect(groqCostUSD(3600)).toBeCloseTo(GROQ_WHISPER_USD_PER_HOUR);
  });

  it("computes 700 billed seconds at 700 * 0.04 / 3600", () => {
    expect(groqCostUSD(700)).toBeCloseTo((700 * 0.04) / 3600);
  });

  it("accepts a custom rate override", () => {
    expect(groqCostUSD(3600, 1)).toBeCloseTo(1);
  });
});

describe("parseGroqUsage", () => {
  it("bills a 3.2s response duration as the 10s floor", () => {
    const result = parseGroqUsage({ duration: 3.2 });
    expect(result.seconds).toBe(10);
    expect(result.costUSD).toBeCloseTo((10 * 0.04) / 3600);
  });

  it("bills a 700s response duration as 700s with cost 700*0.04/3600", () => {
    const result = parseGroqUsage({ duration: 700 });
    expect(result.seconds).toBe(700);
    expect(result.costUSD).toBeCloseTo((700 * 0.04) / 3600);
  });

  it("falls back to the 10s floor when duration is missing/invalid (a successful call still bills something)", () => {
    expect(parseGroqUsage({}).seconds).toBe(10);
    expect(parseGroqUsage(undefined).seconds).toBe(10);
    expect(parseGroqUsage(null).seconds).toBe(10);
    expect(parseGroqUsage({ duration: NaN }).seconds).toBe(10);
  });
});

describe("SUNO_GENERATE_UNITS", () => {
  it("is 1 (one unit per accepted generate call)", () => {
    expect(SUNO_GENERATE_UNITS).toBe(1);
  });
});
