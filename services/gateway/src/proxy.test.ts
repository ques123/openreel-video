import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, PROXY_UPSTREAMS, UNLIMITED_QUOTAS } from "@wizz/contracts";
import {
  deriveUsageForFailure,
  deriveUsageFromUpstreamJson,
  findAllowedUpstream,
  isUnmeteredCall,
  proxyRestPath,
  tryParseUpstreamJson,
} from "./proxy";
import { ADMIN_ORIGIN, PUBLIC_ORIGIN, setupTest, signUpUser } from "./test-helpers";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/* ─────────────────────────── pure: route matching ─────────────────────────── */

describe("proxyRestPath", () => {
  it("strips the fixed /api/proxy/<provider>/ prefix", () => {
    expect(proxyRestPath("/api/proxy/openai/chat/completions", "openai")).toBe("chat/completions");
  });

  it("returns null when the pathname doesn't carry that exact provider prefix", () => {
    expect(proxyRestPath("/api/proxy/groq/chat/completions", "openai")).toBeNull();
    expect(proxyRestPath("/api/proxy/openai", "openai")).toBeNull(); // no trailing slash/rest at all
  });
});

describe("findAllowedUpstream", () => {
  it("matches every whitelisted provider/method/path combination", () => {
    expect(findAllowedUpstream("openai", "POST", "chat/completions")).toEqual({
      base: PROXY_UPSTREAMS.openai.base,
      path: "chat/completions",
    });
    expect(findAllowedUpstream("openai", "GET", "models")).toEqual({ base: PROXY_UPSTREAMS.openai.base, path: "models" });
    expect(findAllowedUpstream("openrouter", "POST", "chat/completions")).toEqual({
      base: PROXY_UPSTREAMS.openrouter.base,
      path: "chat/completions",
    });
    expect(findAllowedUpstream("groq", "POST", "audio/transcriptions")).toEqual({
      base: PROXY_UPSTREAMS.groq.base,
      path: "audio/transcriptions",
    });
    expect(findAllowedUpstream("suno", "POST", "generate")).toEqual({ base: PROXY_UPSTREAMS.suno.base, path: "generate" });
    expect(findAllowedUpstream("suno", "GET", "generate/record-info")).toEqual({
      base: PROXY_UPSTREAMS.suno.base,
      path: "generate/record-info",
    });
  });

  it("is case-insensitive on method but case-sensitive/exact on path", () => {
    expect(findAllowedUpstream("openai", "post", "chat/completions")).not.toBeNull();
    expect(findAllowedUpstream("openai", "POST", "Chat/Completions")).toBeNull();
  });

  it("rejects an unlisted path", () => {
    expect(findAllowedUpstream("openai", "POST", "completions")).toBeNull();
    expect(findAllowedUpstream("openai", "POST", "chat/completions/extra")).toBeNull();
  });

  it("rejects the right path with the wrong method", () => {
    expect(findAllowedUpstream("openai", "GET", "chat/completions")).toBeNull();
    expect(findAllowedUpstream("suno", "POST", "generate/record-info")).toBeNull();
  });

  it("rejects an unknown provider", () => {
    expect(findAllowedUpstream("anthropic", "POST", "chat/completions")).toBeNull();
    expect(findAllowedUpstream("", "POST", "chat/completions")).toBeNull();
  });

  it("rejects a trailing slash — not byte-for-byte equal to the whitelisted string", () => {
    expect(findAllowedUpstream("openai", "POST", "chat/completions/")).toBeNull();
  });

  it("rejects path-traversal-shaped rest paths", () => {
    expect(findAllowedUpstream("openai", "POST", "../admin/health")).toBeNull();
    expect(findAllowedUpstream("openai", "POST", "chat/../chat/completions")).toBeNull();
    expect(findAllowedUpstream("openai", "POST", "..")).toBeNull();
  });

  it("rejects absolute-URL-shaped rest paths (no scheme/host smuggling)", () => {
    expect(findAllowedUpstream("openai", "POST", "http://evil.example/chat/completions")).toBeNull();
    expect(findAllowedUpstream("openai", "POST", "//evil.example/chat/completions")).toBeNull();
  });

  it("rejects double-encoded-looking rest paths — this function does no decoding, exact match only", () => {
    expect(findAllowedUpstream("openai", "POST", "chat%2Fcompletions")).toBeNull();
    expect(findAllowedUpstream("openai", "POST", "chat%252Fcompletions")).toBeNull();
  });
});

describe("isUnmeteredCall", () => {
  it("is true only for suno GET generate/record-info", () => {
    expect(isUnmeteredCall("suno", "generate/record-info", "GET")).toBe(true);
    expect(isUnmeteredCall("suno", "generate", "POST")).toBe(false);
    expect(isUnmeteredCall("openai", "chat/completions", "POST")).toBe(false);
    expect(isUnmeteredCall("suno", "generate/record-info", "POST")).toBe(false);
  });
});

/* ─────────────────────────── pure: upstream JSON + usage derivation ─────────────────────────── */

describe("tryParseUpstreamJson", () => {
  it("parses valid JSON bytes", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    expect(tryParseUpstreamJson(bytes)).toEqual({ ok: true, json: { a: 1 } });
  });

  it("treats empty bytes as not-JSON", () => {
    expect(tryParseUpstreamJson(new Uint8Array(0))).toEqual({ ok: false });
  });

  it("treats an HTML body as not-JSON", () => {
    expect(tryParseUpstreamJson(new TextEncoder().encode("<html>nope</html>"))).toEqual({ ok: false });
  });
});

describe("deriveUsageFromUpstreamJson", () => {
  it("openai/openrouter: tokens+cached+cost from response.usage, model from the request, frames only for caption", () => {
    const json = {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 300 },
        cost: 0.002,
      },
    };
    expect(deriveUsageFromUpstreamJson("openai", "director", json, "gpt-5.4-mini", 0)).toEqual({
      model: "gpt-5.4-mini",
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 300,
      frames: null,
      seconds: null,
      units: null,
      actualCostUSD: 0.002,
    });

    const caption = deriveUsageFromUpstreamJson("openrouter", "caption", json, "qwen/qwen3-vl-235b-a22b-instruct", 4);
    expect(caption.frames).toBe(4);
    expect(caption.model).toBe("qwen/qwen3-vl-235b-a22b-instruct");
  });

  it("groq: seconds/cost from response.duration; model is always null", () => {
    const usage = deriveUsageFromUpstreamJson("groq", "stt", { duration: 700 }, null, 0);
    expect(usage.model).toBeNull();
    expect(usage.seconds).toBe(700);
    expect(usage.actualCostUSD).toBeCloseTo((700 * 0.04) / 3600);
    expect(usage.promptTokens).toBeNull();
  });

  it("suno: units=1 and every other field null", () => {
    expect(deriveUsageFromUpstreamJson("suno", "music", { code: 200 }, null, 0)).toEqual({
      model: null,
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      frames: null,
      seconds: null,
      units: 1,
      actualCostUSD: null,
    });
  });
});

describe("deriveUsageForFailure", () => {
  it("keeps the request-known model for director/caption but not for stt/music", () => {
    expect(deriveUsageForFailure("director", "gpt-5.2", 0).model).toBe("gpt-5.2");
    expect(deriveUsageForFailure("caption", "gpt-5.2", 0).model).toBe("gpt-5.2");
    expect(deriveUsageForFailure("stt", null, 0).model).toBeNull();
    expect(deriveUsageForFailure("music", null, 0).model).toBeNull();
  });

  it("keeps the pre-known caption frame count even on failure", () => {
    expect(deriveUsageForFailure("caption", "gpt-5.2", 7).frames).toBe(7);
    expect(deriveUsageForFailure("director", "gpt-5.2", 7).frames).toBeNull();
  });

  it("every numeric usage field is null", () => {
    const usage = deriveUsageForFailure("director", "gpt-5.2", 0);
    expect(usage.promptTokens).toBeNull();
    expect(usage.completionTokens).toBeNull();
    expect(usage.cachedTokens).toBeNull();
    expect(usage.seconds).toBeNull();
    expect(usage.units).toBeNull();
    expect(usage.actualCostUSD).toBeNull();
  });
});

/* ─────────────────────────── integration: the full check order ─────────────────────────── */

const CHAT_HEADERS = (cookie: string, category = "director") => ({
  "content-type": "application/json",
  origin: PUBLIC_ORIGIN,
  cookie,
  "x-wizz-category": category,
});
const CHAT_BODY = JSON.stringify({ model: "gpt-5.4-mini", messages: [] });

describe("proxy: acceptance — unauthenticated calls are rejected", () => {
  it("no session cookie at all -> auth_required", async () => {
    const { publicApp } = setupTest(vi.fn());
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "x-wizz-category": "director" },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(401);
    expect((await res.json() as any).error.code).toBe("auth_required");
  });
});

describe("proxy: full happy path", () => {
  it("forwards to the upstream, strips the client Authorization header, injects the real key, relays the body, and records usage", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect((init?.headers as Headers).get("authorization")).toBe("Bearer test-openai-key");
      expect((init?.headers as Headers).get("content-type")).toBe("application/json");
      return jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
      });
    });
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);

    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { ...CHAT_HEADERS(cookie), authorization: "Bearer client-supplied-should-be-stripped" },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("hi");

    const row = db.prepare("SELECT * FROM usage_events WHERE user_id = ?").get(userId) as Record<string, unknown>;
    expect(row.provider).toBe("openai");
    expect(row.category).toBe("director");
    expect(row.model).toBe("gpt-5.4-mini");
    expect(row.prompt_tokens).toBe(10);
    expect(row.completion_tokens).toBe(5);
    expect(row.cached_tokens).toBe(2);
    expect(row.upstream_status).toBe(200);
  });
});

describe("proxy: kill switch", () => {
  it("503s with kill_switch and never calls fetch", async () => {
    const fetchImpl = vi.fn();
    const { publicApp, db, deps } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, killSwitch: true });

    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error.code).toBe("kill_switch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("proxy: path whitelist", () => {
  it("forbidden_path for an unlisted path", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.code).toBe("forbidden_path");
  });

  it("forbidden_path for the right path with the wrong method", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "GET",
      headers: { origin: PUBLIC_ORIGIN, cookie, "x-wizz-category": "director" },
    });
    expect((await res.json() as any).error.code).toBe("forbidden_path");
  });
});

describe("proxy: x-wizz-category validation", () => {
  it("bad_request when the header is missing", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie },
      body: CHAT_BODY,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("bad_request");
  });

  it("bad_request for an invalid category value", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie, "not-a-real-category"),
      body: CHAT_BODY,
    });
    expect((await res.json() as any).error.code).toBe("bad_request");
  });

  it("bad_request when the category isn't billable by this provider (stt on openai)", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie, "stt"),
      body: CHAT_BODY,
    });
    expect((await res.json() as any).error.code).toBe("bad_request");
  });
});

describe("proxy: body cap", () => {
  it("413s a body over the provider's byte cap (suno: 256KB)", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/suno/generate", {
      method: "POST",
      headers: CHAT_HEADERS(cookie, "music"),
      body: JSON.stringify({ prompt: "x".repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect((await res.json() as any).error.code).toBe("payload_too_large");
  });
});

describe("proxy: rate limits", () => {
  it("rate-limits per-user on the public listener (60/min)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [{ message: { role: "assistant", content: "hi" } }] }));
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    const headers = CHAT_HEADERS(cookie);
    let last: Response | undefined;
    for (let i = 0; i < 60; i += 1) {
      last = await publicApp.request("/api/proxy/openai/chat/completions", { method: "POST", headers, body: CHAT_BODY });
    }
    expect(last!.status).toBe(200);
    const over = await publicApp.request("/api/proxy/openai/chat/completions", { method: "POST", headers, body: CHAT_BODY });
    expect(over.status).toBe(429);
    expect((await over.json() as any).error.code).toBe("rate_limited");
  });

  it("does not rate-limit proxy calls on the admin listener", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [{ message: { role: "assistant", content: "hi" } }] }));
    const { adminApp, publicApp, db } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    const headers = { ...CHAT_HEADERS(cookie), origin: ADMIN_ORIGIN };
    for (let i = 0; i < 65; i += 1) {
      const res = await adminApp.request("/api/proxy/openai/chat/completions", { method: "POST", headers, body: CHAT_BODY });
      expect(res.status).toBe(200);
    }
  });
});

describe("proxy: quota", () => {
  it("quota_exceeded once today's recorded usage reaches the effective limit (race window: the call that crosses it still lands)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
    const { publicApp, db, deps } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, defaultQuotas: { ...UNLIMITED_QUOTAS, directorTokens: 100 } });

    const first = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(first.status).toBe(200); // pre-check saw used=0 < 100

    const second = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(second.status).toBe(402);
    const errBody = (await second.json()) as { error: { code: string; category: string; resetsAt: string } };
    expect(errBody.error.code).toBe("quota_exceeded");
    expect(errBody.error.category).toBe("directorTokens");
    expect(errBody.error.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  it("null (unlimited) default always passes regardless of usage", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [{ message: { role: "assistant", content: "hi" } }] }));
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    for (let i = 0; i < 3; i += 1) {
      const res = await publicApp.request("/api/proxy/openai/chat/completions", {
        method: "POST",
        headers: CHAT_HEADERS(cookie),
        body: CHAT_BODY,
      });
      expect(res.status).toBe(200);
    }
  });

  it("a per-user override beats the global default", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [{ message: { role: "assistant", content: "hi" } }] }));
    const { publicApp, db, deps } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, defaultQuotas: { ...UNLIMITED_QUOTAS, sunoGens: 0 } });
    db.prepare("UPDATE users SET quota_overrides = ? WHERE id = ?").run(JSON.stringify({ sunoGens: 5 }), userId);

    const res = await publicApp.request("/api/proxy/suno/generate", {
      method: "POST",
      headers: CHAT_HEADERS(cookie, "music"),
      body: JSON.stringify({ prompt: "calm piano" }),
    });
    expect(res.status).toBe(200); // default of 0 would reject; the override of 5 passes
  });

  it("caption calls pre-count image parts and reject if they alone would reach the limit", async () => {
    const fetchImpl = vi.fn();
    const { publicApp, db, deps } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, defaultQuotas: { ...UNLIMITED_QUOTAS, cloudCaptionFrames: 3 } });

    const body = JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:1" } },
            { type: "image_url", image_url: { url: "data:2" } },
            { type: "image_url", image_url: { url: "data:3" } },
          ],
        },
      ],
    });
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie, "caption"),
      body,
    });
    expect(res.status).toBe(402);
    expect((await res.json() as any).error.category).toBe("cloudCaptionFrames");
    expect(fetchImpl).not.toHaveBeenCalled(); // rejected before ever forwarding
  });
});

describe("proxy: usage recorded on failure", () => {
  it("records a usage row (request-known model, null usage fields) on a 5xx upstream response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(res.status).toBe(502);
    expect((await res.json() as any).error.code).toBe("upstream_error");
    const row = db.prepare("SELECT * FROM usage_events WHERE user_id = ?").get(userId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.model).toBe("gpt-5.4-mini");
    expect(row.prompt_tokens).toBeNull();
    expect(row.upstream_status).toBe(500);
  });

  it("records a usage row with a null upstream_status on a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(res.status).toBe(502);
    const row = db.prepare("SELECT * FROM usage_events WHERE user_id = ?").get(userId) as Record<string, unknown>;
    expect(row.upstream_status).toBeNull();
  });

  it("treats a non-JSON 200 response as upstream_error (e.g. an nginx SPA fallback) and still records the attempt", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(res.status).toBe(502);
    expect((await res.json() as any).error.code).toBe("upstream_error");
    const row = db.prepare("SELECT * FROM usage_events WHERE user_id = ?").get(userId) as Record<string, unknown>;
    expect(row.upstream_status).toBe(200);
  });

  it("relays a 4xx JSON error body verbatim, not wrapped in the gateway's own envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: { message: "rate limited by openai", type: "rate_limit_error" } }));
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: "rate limited by openai", type: "rate_limit_error" } });
  });
});

describe("proxy: account state", () => {
  it("account_disabled for a disabled user with an otherwise-valid session", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie, userId } = await signUpUser(publicApp, db);
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: CHAT_BODY,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.code).toBe("account_disabled");
  });
});

describe("proxy: malformed JSON body", () => {
  it("bad_request when a JSON-provider body is not valid JSON", async () => {
    const { publicApp, db } = setupTest(vi.fn());
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/proxy/openai/chat/completions", {
      method: "POST",
      headers: CHAT_HEADERS(cookie),
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("bad_request");
  });
});

describe("proxy: suno record-info is metered-free", () => {
  it("forwards+relays with no usage row and no quota check at all", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe("https://api.sunoapi.org/api/v1/generate/record-info?taskId=abc");
      return jsonResponse(200, { code: 200, data: { status: "PENDING" } });
    });
    const { publicApp, db, deps } = setupTest(fetchImpl);
    const { cookie } = await signUpUser(publicApp, db);
    // A zero quota would reject any metered music call — proves record-info skips the check entirely.
    deps.settings.set({ ...DEFAULT_GLOBAL_SETTINGS, defaultQuotas: { ...UNLIMITED_QUOTAS, sunoGens: 0 } });

    const res = await publicApp.request("/api/proxy/suno/generate/record-info?taskId=abc", {
      method: "GET",
      headers: { origin: PUBLIC_ORIGIN, cookie, "x-wizz-category": "music" },
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const count = db.prepare("SELECT COUNT(*) as n FROM usage_events").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("proxy: groq multipart forwarding", () => {
  it("forwards the multipart content-type (with boundary) unmodified and bills the reported duration", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Headers).get("content-type")).toBe("multipart/form-data; boundary=----test123");
      return jsonResponse(200, { text: "hello", duration: 12.3, segments: [], words: [] });
    });
    const { publicApp, db } = setupTest(fetchImpl);
    const { cookie, userId } = await signUpUser(publicApp, db);

    const res = await publicApp.request("/api/proxy/groq/audio/transcriptions", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=----test123",
        origin: PUBLIC_ORIGIN,
        cookie,
        "x-wizz-category": "stt",
      },
      body: '------test123\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n------test123--',
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT seconds, model FROM usage_events WHERE user_id = ?").get(userId) as {
      seconds: number;
      model: string | null;
    };
    expect(row.seconds).toBe(12.3);
    expect(row.model).toBeNull(); // groq model is intentionally left null
  });
});
