/**
 * The metered proxy: ALL /api/proxy/:provider/* — the 10-step check order
 * from contracts §2. Route matching + usage derivation are pure/exported for
 * direct unit testing (the traversal/double-encoding/absolute-URL fuzz cases
 * are proven against these pure functions rather than against however a
 * particular HTTP stack happens to normalize a raw request line — see the
 * WS-B report for why: both @hono/node-server and the WHATWG URL parser
 * already collapse dot-segments before this code ever sees a path, so
 * exact-string-match-against-a-whitelist is the actual safety net, not
 * bespoke ".." detection).
 */
import type { Context, Hono } from "hono";
import type Database from "better-sqlite3";
import {
  PROVIDER_CATEGORIES,
  PROXY_BODY_LIMIT_BYTES,
  PROXY_UPSTREAMS,
  USAGE_CATEGORIES,
  USAGE_PROVIDERS,
  WIZZ_CATEGORY_HEADER,
  type UsageCategory,
  type UsageProvider,
} from "@wizz/contracts";
import type { Vars } from "./context";
import type { SettingsCache } from "./db";
import type { GatewayEnv } from "./env";
import { WizzError } from "./errors";
import { effectiveQuotaLimit, precheckQuota, quotaCategoryFor, type QuotaStore } from "./quota";
import type { RateLimiter } from "./rate-limit";
import { clientIp, sessionOrSyntheticAdmin } from "./sessions";
import {
  countImageParts,
  extractRequestModel,
  parseChatUsage,
  parseGroqUsage,
  sunoGenerateUnits,
  type RawChatUsage,
  type RawGroqTranscription,
} from "./usage-parse";
import { newId } from "./crypto-ids";

/* ─────────────────────────── pure: route matching ─────────────────────────── */

const PROXY_PREFIX = "/api/proxy/";

export function isUsageProvider(value: string): value is UsageProvider {
  return (USAGE_PROVIDERS as readonly string[]).includes(value);
}

export function isUsageCategory(value: string): value is UsageCategory {
  return (USAGE_CATEGORIES as readonly string[]).includes(value);
}

/** Strips the fixed "/api/proxy/<provider>/" prefix; null if the pathname doesn't actually have that prefix. */
export function proxyRestPath(pathname: string, provider: string): string | null {
  const prefix = `${PROXY_PREFIX}${provider}/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null;
}

export interface MatchedUpstream {
  base: string;
  /** The canonical whitelist path string — used to build the upstream URL, never the caller's raw input. */
  path: string;
}

/**
 * Exact string+method match against PROXY_UPSTREAMS[provider].allow. No
 * normalization of its own: whatever the URL layer already resolved
 * (dot-segments, percent-decoding per decodeURI's reserved-char rules) is
 * compared as-is against a small fixed whitelist, so there is no path that
 * can be encoded/traversed/absolute-URL'd into matching an entry it isn't
 * byte-for-byte equal to.
 */
export function findAllowedUpstream(
  provider: string,
  method: string,
  restPath: string,
): MatchedUpstream | null {
  if (!isUsageProvider(provider)) return null;
  const cfg = PROXY_UPSTREAMS[provider];
  const upperMethod = method.toUpperCase();
  const match = cfg.allow.find((a) => a.method === upperMethod && a.path === restPath);
  return match ? { base: cfg.base, path: match.path } : null;
}

/** suno's record-info poll is session-checked like everything else but never metered/quota'd (contracts §2). */
export function isUnmeteredCall(provider: UsageProvider, path: string, method: string): boolean {
  return provider === "suno" && method === "GET" && path === "generate/record-info";
}

/* ─────────────────────────── pure: upstream JSON parsing ─────────────────────────── */

export type UpstreamJsonResult = { ok: true; json: unknown } | { ok: false };

/** Empty body or invalid JSON both count as "not JSON" — every whitelisted upstream path returns JSON on any status. */
export function tryParseUpstreamJson(bytes: Uint8Array): UpstreamJsonResult {
  const text = new TextDecoder().decode(bytes);
  if (!text) return { ok: false };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/* ─────────────────────────── pure: usage derivation ─────────────────────────── */

export interface DerivedUsage {
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  frames: number | null;
  seconds: number | null;
  units: number | null;
  actualCostUSD: number | null;
}

const NO_USAGE: DerivedUsage = {
  model: null,
  promptTokens: null,
  completionTokens: null,
  cachedTokens: null,
  frames: null,
  seconds: null,
  units: null,
  actualCostUSD: null,
};

/** Usage parsing for a call whose upstream response body was successfully read as JSON (2xx or a JSON-bodied 4xx). */
export function deriveUsageFromUpstreamJson(
  provider: UsageProvider,
  category: UsageCategory,
  upstreamJson: unknown,
  requestModel: string | null,
  framesInRequest: number,
): DerivedUsage {
  if (provider === "groq") {
    const parsed = parseGroqUsage(upstreamJson as RawGroqTranscription);
    return { ...NO_USAGE, seconds: parsed.seconds, actualCostUSD: parsed.costUSD };
  }
  if (provider === "suno") {
    // HTTP 2xx is NOT proof of acceptance — sunoapi.org rejects with 200 + an
    // inner code:400. Bill a unit only when the inner envelope queued a job.
    return { ...NO_USAGE, units: sunoGenerateUnits(upstreamJson) };
  }
  // openai / openrouter chat completions (director or caption)
  const usage = parseChatUsage((upstreamJson as { usage?: RawChatUsage } | null)?.usage);
  return {
    model: requestModel,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    cachedTokens: usage?.cachedTokens ?? null,
    frames: category === "caption" ? framesInRequest : null,
    seconds: null,
    units: null,
    actualCostUSD: usage?.costUSD ?? null,
  };
}

/** No usable response (network error, 5xx, non-JSON) — record what we knew from the REQUEST only. */
export function deriveUsageForFailure(
  category: UsageCategory,
  requestModel: string | null,
  framesInRequest: number,
): DerivedUsage {
  return {
    ...NO_USAGE,
    model: category === "director" || category === "caption" ? requestModel : null,
    frames: category === "caption" ? framesInRequest : null,
  };
}

/* ─────────────────────────── the handler ─────────────────────────── */

export interface ProxyDeps {
  db: Database.Database;
  env: GatewayEnv;
  settings: SettingsCache;
  quotaStore: QuotaStore;
  userLimiter: RateLimiter;
  ipLimiter: RateLimiter;
  fetchImpl: typeof fetch;
}

function apiKeyForProvider(env: GatewayEnv, provider: UsageProvider): string {
  switch (provider) {
    case "openai":
      return env.openaiKey;
    case "openrouter":
      return env.openrouterKey;
    case "groq":
      return env.groqKey;
    case "suno":
      return env.sunoKey;
  }
}

interface UsageEventInsert extends DerivedUsage {
  id: string;
  userId: string;
  provider: UsageProvider;
  category: UsageCategory;
  upstreamStatus: number | null;
  at: string;
}

function insertUsageEvent(db: Database.Database, e: UsageEventInsert): void {
  db.prepare(
    `INSERT INTO usage_events
       (id, user_id, provider, category, model, prompt_tokens, completion_tokens,
        cached_tokens, frames, seconds, units, actual_cost_usd, upstream_status, at)
     VALUES
       (@id, @userId, @provider, @category, @model, @promptTokens, @completionTokens,
        @cachedTokens, @frames, @seconds, @units, @actualCostUSD, @upstreamStatus, @at)`,
  ).run(e);
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SUNO_GENERATE_TIMEOUT_MS = 120_000;

async function handleProxy(c: Context<{ Variables: Vars }>, deps: ProxyDeps): Promise<Response> {
  // Step 1 already ran as route middleware (sessionOrSyntheticAdmin): on the public surface that is
  // exactly the old strict session+disabled gate; on the admin surface `user` may be the synthetic
  // tailnet admin (see sessions.ts). Steps 2-10 below are identical on both surfaces except step 6.
  const user = c.get("user");
  if (!user) throw new WizzError("auth_required");

  // Step 2: kill switch.
  const settings = deps.settings.get();
  if (settings.killSwitch) throw new WizzError("kill_switch");

  // Step 3: method + path vs the provider's whitelist.
  const providerParam = c.req.param("provider") ?? "";
  const url = new URL(c.req.url);
  const restPath = proxyRestPath(url.pathname, providerParam);
  const matched = restPath !== null ? findAllowedUpstream(providerParam, c.req.method, restPath) : null;
  if (!matched || !isUsageProvider(providerParam)) throw new WizzError("forbidden_path");
  const provider = providerParam;

  // Step 4: x-wizz-category header, present + valid + billable by this provider.
  const categoryHeader = c.req.header(WIZZ_CATEGORY_HEADER);
  if (!categoryHeader || !isUsageCategory(categoryHeader)) {
    throw new WizzError("bad_request", "Missing or invalid x-wizz-category header.");
  }
  const category = categoryHeader;
  if (!PROVIDER_CATEGORIES[provider].includes(category)) {
    throw new WizzError("bad_request", `${provider} cannot bill category "${category}".`);
  }

  // Step 5: body cap. Buffered once here — reused for the JSON parse below (when applicable) and for forwarding.
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  if (bodyBytes.byteLength > PROXY_BODY_LIMIT_BYTES[provider]) {
    throw new WizzError("payload_too_large");
  }

  // Step 6: rate limits — public listener only (admin/lab traffic isn't throttled here).
  const surface = c.get("surface");
  if (surface === "public") {
    const userLimit = deps.userLimiter.check(`user:${user.id}`);
    if (!userLimit.ok) {
      throw new WizzError("rate_limited", undefined, { retryAfterS: userLimit.retryAfterS });
    }
    const ipLimit = deps.ipLimiter.check(`ip:${clientIp(c)}`);
    if (!ipLimit.ok) {
      throw new WizzError("rate_limited", undefined, { retryAfterS: ipLimit.retryAfterS });
    }
  }

  // openai/openrouter/suno bodies are JSON (director/caption chat calls, suno generate); groq is multipart and
  // is never parsed here — its usage comes from the upstream response, not the request.
  let parsedRequestBody: unknown;
  if (provider !== "groq" && bodyBytes.byteLength > 0) {
    try {
      parsedRequestBody = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      throw new WizzError("bad_request", "Request body must be valid JSON.");
    }
  }
  const requestModel =
    category === "director" || category === "caption" ? extractRequestModel(parsedRequestBody) : null;
  const framesInRequest = category === "caption" ? countImageParts(parsedRequestBody) : 0;

  const unmetered = isUnmeteredCall(provider, matched.path, c.req.method);
  const quotaCategory = quotaCategoryFor(category);

  // Step 7: quota pre-check (skipped entirely for suno's metered-free record-info poll).
  if (!unmetered) {
    const effectiveLimit = effectiveQuotaLimit(user.quotaOverrides, settings.defaultQuotas, quotaCategory);
    const precheck = precheckQuota(deps.quotaStore, user.id, quotaCategory, effectiveLimit, framesInRequest);
    if (!precheck.ok) {
      throw new WizzError("quota_exceeded", undefined, { category: quotaCategory, resetsAt: precheck.resetsAt });
    }
  }

  // Step 8: forward. Fresh header set (allowlist, not clone-then-strip) — a client-supplied Authorization
  // header is never even read, let alone forwarded; only content-type rides through unmodified (JSON or
  // multipart, boundary and all — groq needs the exact boundary param to parse the file part).
  const forwardHeaders = new Headers();
  const incomingContentType = c.req.header("content-type");
  if (incomingContentType) forwardHeaders.set("content-type", incomingContentType);
  forwardHeaders.set("authorization", `Bearer ${apiKeyForProvider(deps.env, provider)}`);

  const upstreamUrl = `${matched.base}/${matched.path}${url.search}`;
  const timeoutMs =
    provider === "suno" && matched.path === "generate" ? SUNO_GENERATE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

  const nowIso = new Date().toISOString();
  const recordUsage = (fields: DerivedUsage, upstreamStatus: number | null): void => {
    if (unmetered) return;
    insertUsageEvent(deps.db, {
      ...fields,
      id: newId(),
      userId: user.id,
      provider,
      category,
      upstreamStatus,
      at: nowIso,
    });
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await deps.fetchImpl(upstreamUrl, {
      method: c.req.method,
      headers: forwardHeaders,
      body: bodyBytes.byteLength > 0 ? bodyBytes : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Step 9: network failure / timeout.
    recordUsage(deriveUsageForFailure(category, requestModel, framesInRequest), null);
    throw new WizzError("upstream_error");
  }

  const upstreamBodyBytes = new Uint8Array(await upstreamRes.arrayBuffer());
  const upstreamContentType = upstreamRes.headers.get("content-type");

  // Step 9: 5xx always maps to upstream_error, regardless of body shape.
  if (upstreamRes.status >= 500) {
    recordUsage(deriveUsageForFailure(category, requestModel, framesInRequest), upstreamRes.status);
    throw new WizzError("upstream_error");
  }

  const parsedUpstream = tryParseUpstreamJson(upstreamBodyBytes);
  // Every whitelisted path returns JSON on success; a non-JSON body (e.g. nginx/SPA HTML on a misconfigured
  // route) is treated as broken upstream plumbing regardless of the status code it arrived with.
  if (!parsedUpstream.ok) {
    recordUsage(deriveUsageForFailure(category, requestModel, framesInRequest), upstreamRes.status);
    throw new WizzError("upstream_error");
  }

  // Step 10: relay + record. 4xx (now guaranteed JSON-bodied) relays verbatim; 2xx is the success path.
  const usage = deriveUsageFromUpstreamJson(provider, category, parsedUpstream.json, requestModel, framesInRequest);
  recordUsage(usage, upstreamRes.status);

  // Only content-type rides back — never blindly mirror upstream headers (rate-limit/cache headers, or worse
  // a stray Set-Cookie, have no business reaching the client from here).
  return new Response(upstreamBodyBytes, {
    status: upstreamRes.status,
    headers: upstreamContentType ? { "content-type": upstreamContentType } : undefined,
  });
}

export function registerProxyRoutes(app: Hono<{ Variables: Vars }>, deps: ProxyDeps): void {
  app.all("/api/proxy/:provider/*", sessionOrSyntheticAdmin(deps.db, deps.env), (c) => handleProxy(c, deps));
}
