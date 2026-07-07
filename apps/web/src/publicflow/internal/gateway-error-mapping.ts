/**
 * Maps a runDirectorLoop() failure to the public director's phase error
 * `{code, friendly, retryable}` (types.ts's DirectorPhase "error" case),
 * per docs/wizz-contracts.md §7's GenerateFlowState mapping:
 * `auth_required -> needs-auth`, `quota_exceeded -> quota-exceeded`,
 * `kill_switch|upstream_error -> service-away`, `rate_limited -> stay + retry`.
 * WS-D switches scenes on `code`; this module only decides the code/copy.
 *
 * A `DirectorLoopError` carries only a string `message` (see
 * internal/gateway-chat.ts's header comment for why) — `decodeGatewayError`
 * recovers the original GatewayError's structured fields when the failure
 * came from completeViaGateway; anything else (a genuinely unexpected error,
 * or a loop-level outcome like "no storyboard" / "out of rounds") gets a
 * plain, retryable, generic-but-honest message instead of raw internals.
 *
 * Deliberately NOT handled here: `DirectorLoopError` code "aborted" — a
 * user-initiated cancel is not a failure and must never reach this mapper;
 * use-public-director.ts's reducer intercepts it before calling this.
 */
import { DirectorLoopError } from "@openreel/core";
import { WIZZ_ERROR_CODES, type QuotaCategory, type WizzErrorCode } from "@wizz/contracts";
import { GATEWAY_ERROR_MARKER } from "./gateway-chat";

export interface DirectorPhaseError {
  code: string;
  friendly: string;
  retryable: boolean;
}

export interface DecodedGatewayError {
  code: WizzErrorCode;
  status: number;
  category: QuotaCategory | null;
  resetsAt: string | null;
  retryAfterS: number | null;
  message: string;
}

function isWizzErrorCode(v: unknown): v is WizzErrorCode {
  return typeof v === "string" && (WIZZ_ERROR_CODES as readonly string[]).includes(v);
}

/** Recovers a GatewayError's fields from an encoded message (see gateway-chat.ts); null when the message isn't one. */
export function decodeGatewayError(message: string): DecodedGatewayError | null {
  if (!message.startsWith(GATEWAY_ERROR_MARKER)) return null;
  try {
    const parsed = JSON.parse(message.slice(GATEWAY_ERROR_MARKER.length)) as Record<string, unknown>;
    if (!isWizzErrorCode(parsed.code)) return null;
    return {
      code: parsed.code,
      status: typeof parsed.status === "number" ? parsed.status : 0,
      category: (parsed.category as QuotaCategory | null) ?? null,
      resetsAt: typeof parsed.resetsAt === "string" ? parsed.resetsAt : null,
      retryAfterS: typeof parsed.retryAfterS === "number" ? parsed.retryAfterS : null,
      message: typeof parsed.message === "string" ? parsed.message : "",
    };
  } catch {
    return null;
  }
}

/** "2026-07-08T00:00:00.000Z" -> "00:00 UTC" (falls back to the raw string if it doesn't parse). */
function formatResetTime(resetsAt: string): string {
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return resetsAt;
  return `${d.toISOString().slice(11, 16)} UTC`;
}

const SERVICE_AWAY_FRIENDLY =
  "The director is taking a break — your footage and setup are safe; try again shortly.";

function mapDecodedGatewayError(decoded: DecodedGatewayError): DirectorPhaseError {
  switch (decoded.code) {
    case "quota_exceeded":
      return {
        code: "quota_exceeded",
        friendly: decoded.resetsAt
          ? `You've reached today's limit for this — it resets at ${formatResetTime(decoded.resetsAt)}.`
          : "You've reached today's limit for this.",
        retryable: false,
      };
    case "kill_switch":
      return { code: "kill_switch", friendly: SERVICE_AWAY_FRIENDLY, retryable: true };
    case "upstream_error":
      return { code: "upstream_error", friendly: SERVICE_AWAY_FRIENDLY, retryable: true };
    case "rate_limited":
      return {
        code: "rate_limited",
        friendly: "Too many requests right now — try again in a few seconds.",
        retryable: true,
      };
    case "auth_required":
      return {
        code: "auth_required",
        friendly: "Please sign in again to continue.",
        retryable: false,
      };
    case "account_disabled":
      return {
        code: "account_disabled",
        friendly: "This account has been disabled.",
        retryable: false,
      };
    default:
      return {
        code: decoded.code,
        friendly: decoded.message || "Something went wrong — try again.",
        retryable: true,
      };
  }
}

/** Maps whatever use-public-director.ts's generate()/refine() caught to a DirectorPhase "error" payload. */
export function mapDirectorError(err: unknown): DirectorPhaseError {
  if (err instanceof DirectorLoopError) {
    if (err.code === "api") {
      const decoded = decodeGatewayError(err.message);
      if (decoded) return mapDecodedGatewayError(decoded);
      return { code: "upstream_error", friendly: SERVICE_AWAY_FRIENDLY, retryable: true };
    }
    if (err.code === "no-storyboard") {
      return {
        code: "no_storyboard",
        friendly: "The director couldn't settle on a cut — try a simpler brief or shorter footage set.",
        retryable: true,
      };
    }
    if (err.code === "max-rounds") {
      return {
        code: "max_rounds",
        friendly: "The director ran out of attempts — try a simpler brief.",
        retryable: true,
      };
    }
  }
  return {
    code: "unknown",
    friendly: err instanceof Error && err.message ? err.message : "Something went wrong — try again.",
    retryable: true,
  };
}
