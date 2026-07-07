/**
 * Single source of truth for error responses: every non-2xx response the
 * gateway emits is a WizzApiError envelope with the status from
 * WIZZ_ERROR_STATUS (contracts §2 — tests assert the full mapping). Route
 * handlers throw a WizzError (caught by app.onError in app.ts) or call
 * errorResponse() directly when they already hold a Context.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  WIZZ_ERROR_STATUS,
  type QuotaCategory,
  type WizzErrorCode,
} from "@wizz/contracts";

/** WIZZ_ERROR_STATUS's value type is a plain `number` in the contract; narrowed once here for Hono's c.json(). */
function statusFor(code: WizzErrorCode): ContentfulStatusCode {
  return WIZZ_ERROR_STATUS[code] as ContentfulStatusCode;
}

export interface WizzErrorExtra {
  category?: QuotaCategory;
  resetsAt?: string;
  retryAfterS?: number;
}

/** Human-readable default sentence per code, shown verbatim on admin surfaces (public UI writes its own copy). */
const DEFAULT_MESSAGES: Record<WizzErrorCode, string> = {
  auth_required: "Sign in to continue.",
  invalid_credentials: "Email or password is incorrect.",
  invite_invalid: "That invite code is unknown, expired, exhausted, or disabled.",
  email_taken: "An account with that email already exists.",
  weak_password: "Password must be at least 8 characters.",
  bad_request: "The request was malformed.",
  bad_origin: "Request origin did not match the expected origin.",
  admin_only: "This route is only available on the admin listener.",
  forbidden_path: "That upstream path is not allowed.",
  account_disabled: "This account has been disabled.",
  not_found: "Not found.",
  quota_exceeded: "Today's usage budget for this category is spent.",
  payload_too_large: "Request body exceeds the allowed size for this provider.",
  rate_limited: "Too many requests — slow down.",
  upstream_error: "The upstream provider failed or returned something unexpected.",
  kill_switch: "The director is taking a break — try again shortly.",
};

/** Thrown by route handlers; caught centrally by app.onError and turned into the envelope + status. */
export class WizzError extends Error {
  readonly code: WizzErrorCode;
  readonly extra: WizzErrorExtra;

  constructor(code: WizzErrorCode, message?: string, extra: WizzErrorExtra = {}) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "WizzError";
    this.code = code;
    this.extra = extra;
  }
}

/** Builds the JSON body for a given code — shared by errorResponse and the onError handler. */
export function wizzErrorBody(
  code: WizzErrorCode,
  message?: string,
  extra: WizzErrorExtra = {},
): { error: { code: WizzErrorCode; message: string } & WizzErrorExtra } {
  return {
    error: {
      code,
      message: message ?? DEFAULT_MESSAGES[code],
      ...extra,
    },
  };
}

/** Sends a WizzApiError response directly from a handler that hasn't thrown. */
export function errorResponse(
  c: Context,
  code: WizzErrorCode,
  opts: { message?: string; extra?: WizzErrorExtra } = {},
): Response {
  return c.json(wizzErrorBody(code, opts.message, opts.extra), statusFor(code));
}

/** app.onError target: maps a thrown WizzError to its envelope; anything else is an unexpected bug. */
export function toErrorResponse(err: unknown, c: Context): Response {
  if (err instanceof WizzError) {
    return c.json(wizzErrorBody(err.code, err.message, err.extra), statusFor(err.code));
  }
  // Every intentional failure path should throw WizzError — reaching here means a genuine bug.
  // Logged server-side; the client still gets a well-formed JSON body (never raw markup/stack).
  console.error("[gateway] unhandled error:", err);
  return c.json(
    { error: { code: "upstream_error", message: "Internal server error" } },
    500,
  );
}
