/**
 * describeFramesCloud request shaping + cost accounting: batch size and the
 * scaled max-token guard, watchdog/caller abort-signal composition, and the
 * capture of real billed usage (including cached tokens) from batches whose
 * strict-JSON reply was unusable — billed is billed, retried or not.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CloudFrame } from "@openreel/core";
import { aggregateActualCostUSD, describeFramesCloud, withOpenRouterAccounting } from "./cloud-vision";

// jsdom (unlike every browser this app supports) hasn't implemented
// AbortSignal.any yet — shim it so the composed watchdog path is exercised.
beforeAll(() => {
  if (typeof AbortSignal.any !== "function") {
    AbortSignal.any = (signals: Iterable<AbortSignal>): AbortSignal => {
      const controller = new AbortController();
      for (const s of signals) {
        if (s.aborted) {
          controller.abort(s.reason);
          break;
        }
        s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
      }
      return controller.signal;
    };
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const makeFrames = (n: number): CloudFrame[] =>
  Array.from({ length: n }, (_, i) => ({ t: i, dataUrl: `f${i}` }));

interface SentRequest {
  url: string;
  body: {
    model: string;
    messages: { content: { type: string; image_url?: { url: string } }[] }[];
    max_completion_tokens?: number;
    max_tokens?: number;
    usage?: { include: boolean };
    provider?: { sort: string };
  };
  signal: AbortSignal | null;
}

/** Captions reply covering `count` images, plus a wire-format usage block. */
const okReply = (
  count: number,
  usage: { in: number; out: number; cached?: number; cost?: number },
  text = (i: number) => `caption ${i}`,
) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          captions: Array.from({ length: count }, (_, i) => ({ i: i + 1, text: text(i + 1) })),
        }),
      },
    },
  ],
  usage: {
    prompt_tokens: usage.in,
    completion_tokens: usage.out,
    prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
  },
});

/** A billed response whose content is NOT the strict JSON we demanded. */
const badJsonReply = (usage: { in: number; out: number; cached?: number; cost?: number }) => ({
  choices: [{ message: { content: "sorry, here are your captions: 1) a road" } }],
  usage: {
    prompt_tokens: usage.in,
    completion_tokens: usage.out,
    prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
  },
});

/**
 * fetch stub: records every request and answers via `respond`, which sees the
 * batch's image count and first image url (enough to tell batches apart).
 */
function stubFetch(respond: (imageCount: number, firstImage: string, call: number) => unknown) {
  const sent: SentRequest[] = [];
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string; signal?: AbortSignal | null }) => {
      const body = JSON.parse(init.body ?? "") as SentRequest["body"];
      sent.push({ url, body, signal: init.signal ?? null });
      const images = body.messages[0].content.filter((p) => p.type === "image_url");
      const data = respond(images.length, images[0]?.image_url?.url ?? "", call++);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => data,
        text: async () => "",
      };
    }),
  );
  return sent;
}

describe("describeFramesCloud request shaping", () => {
  it("sends batches of 16 with a max-token guard scaled to batch size", async () => {
    const sent = stubFetch((n) => okReply(n, { in: 100, out: 50 }));
    const run = await describeFramesCloud(makeFrames(20), undefined, undefined, "gpt-5.2");

    expect(sent).toHaveLength(2);
    const sizes = sent
      .map((r) => r.body.messages[0].content.filter((p) => p.type === "image_url").length)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([16, 4]);
    // Bare (OpenAI) ids use max_completion_tokens; guard scales per frame.
    const fullBatch = sent.find((r) => r.body.max_completion_tokens === 16 * 200);
    expect(fullBatch).toBeDefined();
    expect(sent.every((r) => r.body.max_tokens === undefined)).toBe(true);
    expect(run.captions).toHaveLength(20);
    expect(run.framesFailed).toBe(0);
  });

  it("routes provider-prefixed models through OpenRouter with max_tokens instead", async () => {
    const sent = stubFetch((n) => okReply(n, { in: 10, out: 5 }));
    await describeFramesCloud(
      makeFrames(4),
      undefined,
      undefined,
      "qwen/qwen3-vl-235b-a22b-instruct",
    );
    expect(sent[0].url).toContain("/api/proxy/openrouter/");
    expect(sent[0].body.max_tokens).toBe(4 * 200);
    expect(sent[0].body.max_completion_tokens).toBeUndefined();
    // withOpenRouterAccounting: exact-cost capture + price-first routing —
    // captions are the batch cost center, unlike the director's interactive
    // chatComplete calls (see openai-proxy.test.ts, which asserts no
    // provider.sort there).
    expect(sent[0].body.usage).toEqual({ include: true });
    expect(sent[0].body.provider).toEqual({ sort: "price" });
  });

  it("does NOT add usage/provider fields for an OpenAI (bare) model id", async () => {
    const sent = stubFetch((n) => okReply(n, { in: 10, out: 5 }));
    await describeFramesCloud(makeFrames(4), undefined, undefined, "gpt-5.2");
    expect(sent[0].body.usage).toBeUndefined();
    expect(sent[0].body.provider).toBeUndefined();
  });

  it("always arms a watchdog signal, composed with the caller's when given", async () => {
    const sent = stubFetch((n) => okReply(n, { in: 10, out: 5 }));
    const caller = new AbortController();
    await describeFramesCloud(makeFrames(2), undefined, caller.signal, "gpt-5.2");
    expect(sent[0].signal).toBeInstanceOf(AbortSignal);
    expect(sent[0].signal!.aborted).toBe(false);
    // The composed signal follows the caller's abort (the timeout arm is
    // native AbortSignal.timeout and can't be fake-timered).
    caller.abort();
    expect(sent[0].signal!.aborted).toBe(true);

    const sentNoCaller = stubFetch((n) => okReply(n, { in: 10, out: 5 }));
    await describeFramesCloud(makeFrames(2), undefined, undefined, "gpt-5.2");
    expect(sentNoCaller[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("describeFramesCloud cost accounting", () => {
  it("keeps the billed usage of failed strict-JSON batches (both attempts) in the totals", async () => {
    // Batch A (16 frames, starts at f0) succeeds; batch B (4 frames, starts
    // at f16) returns billed-but-unusable JSON on the attempt AND the retry.
    stubFetch((n, first) =>
      first === "f16"
        ? badJsonReply({ in: 111, out: 22, cached: 7 })
        : okReply(n, { in: 1000, out: 400, cached: 300 }),
    );
    const run = await describeFramesCloud(makeFrames(20), undefined, undefined, "gpt-5.2");

    expect(run.framesFailed).toBe(4);
    expect(run.captions).toHaveLength(16);
    // 1 success + 2 billed failures — nothing double-billed-yet-unrecorded.
    expect(run.promptTokens).toBe(1000 + 111 + 111);
    expect(run.completionTokens).toBe(400 + 22 + 22);
    expect(run.cachedTokens).toBe(300 + 7 + 7);
  });

  it("counts a failed-then-successful retry as two billed calls", async () => {
    stubFetch((n, _first, call) =>
      call === 0 ? badJsonReply({ in: 50, out: 10 }) : okReply(n, { in: 60, out: 30, cached: 40 }),
    );
    const run = await describeFramesCloud(makeFrames(4), undefined, undefined, "gpt-5.2");
    expect(run.framesFailed).toBe(0);
    expect(run.captions).toHaveLength(4);
    expect(run.promptTokens).toBe(50 + 60);
    expect(run.completionTokens).toBe(10 + 30);
    expect(run.cachedTokens).toBe(0 + 40);
  });

  it("parses prompt_tokens_details.cached_tokens into the run", async () => {
    stubFetch((n) => okReply(n, { in: 500, out: 100, cached: 450 }));
    const run = await describeFramesCloud(makeFrames(3), undefined, undefined, "gpt-5.2");
    expect(run.promptTokens).toBe(500);
    expect(run.cachedTokens).toBe(450);
  });

  it("sums actualCostUSD when EVERY batch reports one (all-reported case)", async () => {
    // 20 frames -> 2 batches (16 + 4), both report a cost.
    stubFetch((n, first) =>
      first === "f16"
        ? okReply(n, { in: 111, out: 22, cost: 0.00004 })
        : okReply(n, { in: 1000, out: 400, cost: 0.0002 }),
    );
    const run = await describeFramesCloud(makeFrames(20), undefined, undefined, "qwen/qwen3-vl-235b-a22b-instruct");
    expect(run.actualCostUSD).toBeCloseTo(0.0002 + 0.00004, 10);
  });

  it("falls back to null when ONE batch's cost is unreported (partial case)", async () => {
    stubFetch((n, first) =>
      first === "f16"
        ? okReply(n, { in: 111, out: 22 }) // no cost — e.g. an OpenRouter reply that omitted it
        : okReply(n, { in: 1000, out: 400, cost: 0.0002 }),
    );
    const run = await describeFramesCloud(makeFrames(20), undefined, undefined, "qwen/qwen3-vl-235b-a22b-instruct");
    expect(run.actualCostUSD).toBeNull();
  });

  it("is null when NO batch reports a cost (e.g. an OpenAI caption model)", async () => {
    stubFetch((n) => okReply(n, { in: 500, out: 100 }));
    const run = await describeFramesCloud(makeFrames(3), undefined, undefined, "gpt-5.2");
    expect(run.actualCostUSD).toBeNull();
  });

  it("still counts a billed-but-unusable batch's cost toward actualCostUSD", async () => {
    // Single 4-frame batch: fails strict-JSON on the first attempt (billed,
    // reports a cost) then succeeds on the retry (billed, reports a cost).
    stubFetch((n, _first, call) =>
      call === 0
        ? badJsonReply({ in: 50, out: 10, cost: 0.00001 })
        : okReply(n, { in: 60, out: 30, cost: 0.00002 }),
    );
    const run = await describeFramesCloud(makeFrames(4), undefined, undefined, "qwen/qwen3-vl-235b-a22b-instruct");
    expect(run.actualCostUSD).toBeCloseTo(0.00001 + 0.00002, 10);
  });
});

describe("withOpenRouterAccounting", () => {
  it("adds usage.include and provider.sort for an OpenRouter (slash) model id", () => {
    const body = withOpenRouterAccounting({ model: "qwen/qwen3-vl-235b-a22b-instruct" }, "qwen/qwen3-vl-235b-a22b-instruct");
    expect(body).toEqual({
      model: "qwen/qwen3-vl-235b-a22b-instruct",
      usage: { include: true },
      provider: { sort: "price" },
    });
  });

  it("returns the body untouched for an OpenAI (bare) model id", () => {
    const original = { model: "gpt-5.2", max_completion_tokens: 200 };
    const body = withOpenRouterAccounting(original, "gpt-5.2");
    expect(body).toBe(original); // same reference — genuinely untouched
    expect(body).not.toHaveProperty("usage");
    expect(body).not.toHaveProperty("provider");
  });
});

describe("aggregateActualCostUSD", () => {
  it("sums every cost when all batches reported one", () => {
    expect(aggregateActualCostUSD([0.0002, 0.00004, 0.0001])).toBeCloseTo(0.00034, 10);
  });

  it("returns null when some (but not all) batches reported a cost", () => {
    expect(aggregateActualCostUSD([0.0002, null, 0.0001])).toBeNull();
  });

  it("returns null when no batch reported a cost (including the empty/vacuous case)", () => {
    expect(aggregateActualCostUSD([null, null])).toBeNull();
    expect(aggregateActualCostUSD([])).toBeNull();
  });
});
