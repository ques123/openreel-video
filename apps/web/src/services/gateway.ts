/**
 * wizz.video gateway service layer — the client-side counterpart to
 * services/gateway (Hono + SQLite; see docs/wizz-contracts.md §2). Every
 * helper here is a thin, typed wrapper around gatewayFetch: it always adds
 * `credentials: "include"` (the session cookie is httpOnly + SameSite=Lax,
 * same-origin by construction — see contracts §0), parses the `WizzApiError`
 * envelope on failure, and throws exactly one error shape (GatewayError)
 * every caller can catch uniformly.
 *
 * This is NOT the four existing /api/proxy/* call sites (openai-proxy.ts,
 * cloud-vision.ts, groq-stt.ts, suno.ts) — those keep their own hand-rolled
 * fetch + error-mapping (existing tests enforce it) and only gain
 * `credentials: "include"` + the `x-wizz-category` header in place.
 * gateway.ts covers the REST of the HTTP surface: /api/auth/*, /api/preset,
 * /api/quota, /api/telemetry, and /api/admin/* (tailnet-gated — hit from the
 * public listener these 403 `admin_only`, which just falls out of
 * gatewayFetch's normal error mapping, nothing special needed here).
 *
 * Response-shape note: docs/wizz-contracts.md §2 doesn't spell out a JSON
 * body for every mutation (several PATCH/PUT/activate routes just say
 * "→ 200"). Rather than guess an unwritten contract, those helpers resolve
 * `Promise<void>` — Wave-2 UI should re-fetch the relevant list/resource
 * after calling one. Endpoints where the doc DOES give a shape are typed to
 * match it exactly.
 */

import type {
  AdminHealth,
  AdminUser,
  AdminUserSummary,
  GlobalSettings,
  InviteCode,
  LoginRequest,
  PresetResponse,
  PublishedPreset,
  QuotaCategory,
  QuotaLimits,
  QuotaStatus,
  SessionResponse,
  SignupRequest,
  TelemetryEventBody,
  TelemetryType,
  UsageEvent,
  UsageRollupRow,
  WizzApiError,
  WizzErrorCode,
} from "@wizz/contracts";

/**
 * Thrown by gatewayFetch on any non-2xx response (or a 2xx response that
 * doesn't carry the JSON body every gateway route promises). `code` is the
 * machine-readable contract from WizzApiError; `category`/`resetsAt` are
 * populated only for `quota_exceeded`, `retryAfterS` only for
 * `rate_limited` (see WizzApiError's doc comment in @wizz/contracts).
 */
export class GatewayError extends Error {
  readonly code: WizzErrorCode;
  readonly status: number;
  readonly category?: QuotaCategory;
  readonly resetsAt?: string;
  readonly retryAfterS?: number;

  constructor(params: {
    code: WizzErrorCode;
    status: number;
    message: string;
    category?: QuotaCategory;
    resetsAt?: string;
    retryAfterS?: number;
  }) {
    super(params.message);
    this.name = "GatewayError";
    this.code = params.code;
    this.status = params.status;
    this.category = params.category;
    this.resetsAt = params.resetsAt;
    this.retryAfterS = params.retryAfterS;
  }
}

/**
 * fetch()'s second parameter type, derived from `typeof fetch` rather than
 * spelled as the DOM lib's own `RequestInit` name: this project's eslint
 * config's `no-undef` doesn't know about type-only DOM globals absent from
 * its manually curated globals list (see the pre-existing CanvasImageSource
 * errors in transition-bridge.ts/canvas-renderers.ts for the same class of
 * issue) and eslint.config.js is outside this file's ownership — deriving
 * the type sidesteps the false positive instead of naming it directly.
 */
export type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function isJsonResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("json");
}

/**
 * Builds the helpful message for a response that carries no WizzApiError
 * envelope at all — either nothing gateway-shaped answered (nginx's own
 * error page, or a dev server's SPA fallback for a route that isn't
 * proxied/implemented yet) or the body genuinely isn't JSON. Mirrors the
 * "proxy route is not set up" guidance the four existing /api/proxy/* call
 * sites already give (openai-proxy.ts etc.), generalized since gateway.ts
 * has no single apply-*.sh script to name — WS-B's gateway is a whole
 * service, not one nginx location.
 */
function describeNonEnvelopeResponse(path: string, status: number, body: string): string {
  const looksLikeHtml = body.trimStart().startsWith("<");
  if (looksLikeHtml) {
    return (
      `gateway ${path} returned ${status} with an HTML body instead of a JSON error ` +
      "envelope — the gateway likely isn't running or isn't proxied here yet (dev: set " +
      "VITE_DEV_GATEWAY to point at a local services/gateway, or check nginx's /api " +
      "location on the deployed box)"
    );
  }
  const snippet = body.slice(0, 200);
  return `gateway ${path} returned ${status} without a JSON error envelope${snippet ? `: ${snippet}` : ""}`;
}

/**
 * Every gateway call goes through here: adds `credentials: "include"` (the
 * session cookie must ride along — see WIZZ_SESSION_COOKIE), and on failure
 * throws the ONE error shape (GatewayError) every caller handles, instead of
 * a mix of thrown SyntaxErrors, raw Responses, and network TypeErrors.
 *
 * - non-2xx with a parseable `WizzApiError` body -> GatewayError with that
 *   envelope's fields.
 * - non-2xx (or an unexpected 2xx) with a non-JSON/unparseable body ->
 *   GatewayError code "upstream_error" with a helpful message (see
 *   describeNonEnvelopeResponse).
 * - 204 No Content (logout, telemetry) -> resolves `undefined`.
 * - a fetch() that never reaches a Response at all (offline, connection
 *   refused, CORS rejection) -> the same GatewayError upstream_error shape,
 *   so callers never need a second catch clause for network-level failures.
 */
export async function gatewayFetch<T = unknown>(path: string, init: FetchInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: "include" });
  } catch (err) {
    throw new GatewayError({
      code: "upstream_error",
      status: 0,
      message: `could not reach ${path}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (!res.ok) {
    if (isJsonResponse(res)) {
      const parsed = (await res.json().catch(() => null)) as Partial<WizzApiError> | null;
      const envelope = parsed?.error;
      if (envelope?.code) {
        throw new GatewayError({
          code: envelope.code,
          status: res.status,
          message: envelope.message || `gateway error: ${envelope.code}`,
          category: envelope.category,
          resetsAt: envelope.resetsAt,
          retryAfterS: envelope.retryAfterS,
        });
      }
    }
    const body = await res.text().catch(() => "");
    throw new GatewayError({
      code: "upstream_error",
      status: res.status,
      message: describeNonEnvelopeResponse(path, res.status, body),
    });
  }

  if (res.status === 204) return undefined as T;

  if (!isJsonResponse(res)) {
    const body = await res.text().catch(() => "");
    throw new GatewayError({
      code: "upstream_error",
      status: res.status,
      message: describeNonEnvelopeResponse(path, res.status, body),
    });
  }

  return (await res.json()) as T;
}

function jsonInit(method: string, body: unknown): FetchInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* ────────────────────────────── auth ────────────────────────────── */

export function signup(req: SignupRequest): Promise<SessionResponse> {
  return gatewayFetch("/api/auth/signup", jsonInit("POST", req));
}

export function login(req: LoginRequest): Promise<SessionResponse> {
  return gatewayFetch("/api/auth/login", jsonInit("POST", req));
}

export async function logout(): Promise<void> {
  await gatewayFetch("/api/auth/logout", { method: "POST" });
}

export function getSession(): Promise<SessionResponse> {
  return gatewayFetch("/api/auth/session");
}

/* ───────────────────── product config + quota + telemetry ───────────────────── */

export function getPreset(): Promise<PresetResponse> {
  return gatewayFetch("/api/preset");
}

export function getQuota(): Promise<QuotaStatus> {
  return gatewayFetch("/api/quota");
}

/**
 * Fire-and-forget: telemetry must never surface an error to its caller (the
 * generate flow calls this from inside state transitions — a dropped event
 * is fine, a thrown exception mid-transition is not). Swallows GatewayError
 * AND any other rejection; never returns a promise the caller needs to
 * handle.
 */
export function sendTelemetry(type: TelemetryType, data?: TelemetryEventBody["data"]): void {
  const body: TelemetryEventBody = data !== undefined ? { type, data } : { type };
  void gatewayFetch("/api/telemetry", jsonInit("POST", body)).catch(() => {
    // intentionally swallowed — see doc comment above.
  });
}

/* ─────────────────────────── admin API ─────────────────────────── */
/**
 * Thin typed wrappers over the tailnet-gated admin API
 * (docs/wizz-contracts.md §2 "Admin API"). See the file-header note on
 * response shapes the doc leaves unspecified.
 */

export function adminListUsers(q?: string): Promise<{ users: AdminUserSummary[] }> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return gatewayFetch(`/api/admin/users${qs}`);
}

export function adminGetUser(
  id: string,
): Promise<{ user: AdminUserSummary; recent: UsageEvent[] }> {
  return gatewayFetch(`/api/admin/users/${encodeURIComponent(id)}`);
}

export interface AdminPatchUserBody {
  disabled?: boolean;
  /** Sparse per-category overrides; `null` clears all overrides (see AdminUser.quotaOverrides). */
  quotaOverrides?: Partial<QuotaLimits> | null;
}

export function adminPatchUser(
  id: string,
  body: AdminPatchUserBody,
): Promise<{ user: AdminUser }> {
  return gatewayFetch(`/api/admin/users/${encodeURIComponent(id)}`, jsonInit("PATCH", body));
}

export function adminResetPassword(id: string): Promise<{ tempPassword: string }> {
  return gatewayFetch(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, {
    method: "POST",
  });
}

export function adminListInvites(): Promise<{ invites: InviteCode[] }> {
  return gatewayFetch("/api/admin/invites");
}

export interface AdminCreateInviteBody {
  maxUses: number;
  expiresAt?: string | null;
  note?: string | null;
}

export function adminCreateInvite(body: AdminCreateInviteBody): Promise<{ invite: InviteCode }> {
  return gatewayFetch("/api/admin/invites", jsonInit("POST", body));
}

export interface AdminPatchInviteBody {
  disabled: boolean;
}

/** Doc gives no response shape for this route ("→ 200") — see file header. */
export async function adminPatchInvite(id: string, body: AdminPatchInviteBody): Promise<void> {
  await gatewayFetch(`/api/admin/invites/${encodeURIComponent(id)}`, jsonInit("PATCH", body));
}

export type AdminUsageGroupBy = "day" | "user" | "provider" | "model" | "category";

export interface AdminUsageParams {
  groupBy?: AdminUsageGroupBy[];
  /** UTC date, inclusive, "YYYY-MM-DD"; server defaults to the last 30 days. */
  from?: string;
  to?: string;
}

export function adminGetUsage(params: AdminUsageParams = {}): Promise<{ rows: UsageRollupRow[] }> {
  const search = new URLSearchParams();
  if (params.groupBy?.length) search.set("groupBy", params.groupBy.join(","));
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  const qs = search.toString();
  return gatewayFetch(`/api/admin/usage${qs ? `?${qs}` : ""}`);
}

export function adminGetSettings(): Promise<GlobalSettings> {
  return gatewayFetch("/api/admin/settings");
}

/** Doc gives no response shape for this route ("→ 200") — see file header. */
export async function adminPutSettings(settings: GlobalSettings): Promise<void> {
  await gatewayFetch("/api/admin/settings", jsonInit("PUT", settings));
}

export function adminListPresets(): Promise<{ presets: PublishedPreset[] }> {
  return gatewayFetch("/api/admin/presets");
}

/**
 * Saves an EXISTING published preset (PUT /api/admin/presets/:id, which
 * bumps `version` server-side) — the common "edit the preset" action. Doc
 * gives no response shape for this route — see file header. Creating a
 * brand-new preset id (POST /api/admin/presets) isn't exposed here since
 * only `adminSavePreset` was in this wave's scope; add `adminCreatePreset`
 * alongside the real Presets page in Wave 2 if that's needed.
 */
export async function adminSavePreset(preset: PublishedPreset): Promise<void> {
  await gatewayFetch(`/api/admin/presets/${encodeURIComponent(preset.id)}`, jsonInit("PUT", preset));
}

/** Doc gives no response shape for this route — see file header. */
export async function adminActivatePreset(id: string): Promise<void> {
  await gatewayFetch(`/api/admin/presets/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

export function adminGetHealth(): Promise<AdminHealth> {
  return gatewayFetch("/api/admin/health");
}
