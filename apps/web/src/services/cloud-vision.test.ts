/**
 * describeFramesCloud request shaping + cost accounting: batch size and the
 * scaled max-token guard, watchdog/caller abort-signal composition, and the
 * capture of real billed usage (including cached tokens) from batches whose
 * strict-JSON reply was unusable — billed is billed, retried or not.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CloudFrame } from "@openreel/core";
import { describeFramesCloud } from "./cloud-vision";

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
  };
  signal: AbortSignal | null;
}

/** Captions reply covering `count` images, plus a wire-format usage block. */
const okReply = (
  count: number,
  usage: { in: number; out: number; cached?: number },
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
  },
});

/** A billed response whose content is NOT the strict JSON we demanded. */
const badJsonReply = (usage: { in: number; out: number; cached?: number }) => ({
  choices: [{ message: { content: "sorry, here are your captions: 1) a road" } }],
  usage: {
    prompt_tokens: usage.in,
    completion_tokens: usage.out,
    prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
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
});
