import { describe, expect, it } from "vitest";
import { DirectorLoopError } from "@openreel/core";
import { GatewayError } from "../../services/gateway";
import { encodeGatewayError } from "./gateway-chat";
import { decodeGatewayError, mapDirectorError } from "./gateway-error-mapping";

function apiError(err: GatewayError): DirectorLoopError {
  return new DirectorLoopError("api", encodeGatewayError(err));
}

describe("decodeGatewayError", () => {
  it("recovers a GatewayError's fields from its encoded message", () => {
    const err = new GatewayError({
      code: "quota_exceeded",
      status: 402,
      message: "daily budget spent",
      category: "directorTokens",
      resetsAt: "2026-07-08T00:00:00.000Z",
    });
    const decoded = decodeGatewayError(encodeGatewayError(err));
    expect(decoded).toEqual({
      code: "quota_exceeded",
      status: 402,
      category: "directorTokens",
      resetsAt: "2026-07-08T00:00:00.000Z",
      retryAfterS: null,
      message: "daily budget spent",
    });
  });

  it("returns null for a message that isn't the encoded shape", () => {
    expect(decodeGatewayError("OpenAI 500: something broke")).toBeNull();
  });

  it("returns null for malformed JSON after the marker", () => {
    expect(decodeGatewayError("GATEWAY_ERROR:{not json")).toBeNull();
  });

  it("returns null when the decoded code isn't a known WizzErrorCode", () => {
    expect(decodeGatewayError('GATEWAY_ERROR:{"code":"not_a_real_code"}')).toBeNull();
  });
});

describe("mapDirectorError — gateway-backed api failures", () => {
  it("quota_exceeded: not retryable, friendly text includes the reset time", () => {
    const result = mapDirectorError(
      apiError(
        new GatewayError({
          code: "quota_exceeded",
          status: 402,
          message: "spent",
          resetsAt: "2026-07-08T00:00:00.000Z",
        }),
      ),
    );
    expect(result.code).toBe("quota_exceeded");
    expect(result.retryable).toBe(false);
    expect(result.friendly).toContain("00:00 UTC");
  });

  it("quota_exceeded without a resetsAt still produces a friendly, non-retryable result", () => {
    const result = mapDirectorError(
      apiError(new GatewayError({ code: "quota_exceeded", status: 402, message: "spent" })),
    );
    expect(result.retryable).toBe(false);
    expect(result.friendly.length).toBeGreaterThan(0);
  });

  it("kill_switch: the exact 'director taking a break' wireframe copy, retryable", () => {
    const result = mapDirectorError(
      apiError(new GatewayError({ code: "kill_switch", status: 503, message: "down for maintenance" })),
    );
    expect(result.code).toBe("kill_switch");
    expect(result.retryable).toBe(true);
    expect(result.friendly).toBe(
      "The director is taking a break — your footage and setup are safe; try again shortly.",
    );
  });

  it("upstream_error: same 'taking a break' framing as kill_switch, retryable", () => {
    const result = mapDirectorError(
      apiError(new GatewayError({ code: "upstream_error", status: 502, message: "bad gateway" })),
    );
    expect(result.code).toBe("upstream_error");
    expect(result.retryable).toBe(true);
    expect(result.friendly).toContain("taking a break");
  });

  it("rate_limited: retryable, mentions trying again shortly", () => {
    const result = mapDirectorError(
      apiError(new GatewayError({ code: "rate_limited", status: 429, message: "slow down" })),
    );
    expect(result.code).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    expect(result.friendly.toLowerCase()).toContain("too many requests");
  });

  it("auth_required: not retryable (needs a fresh sign-in, not a simple retry)", () => {
    const result = mapDirectorError(
      apiError(new GatewayError({ code: "auth_required", status: 401, message: "no session" })),
    );
    expect(result.code).toBe("auth_required");
    expect(result.retryable).toBe(false);
  });

  it("account_disabled: not retryable", () => {
    const result = mapDirectorError(
      apiError(new GatewayError({ code: "account_disabled", status: 403, message: "disabled" })),
    );
    expect(result.retryable).toBe(false);
  });

  it("an unmapped-but-known WizzErrorCode falls back to the decoded message, still retryable", () => {
    const result = mapDirectorError(
      apiError(new GatewayError({ code: "bad_request", status: 400, message: "bad category header" })),
    );
    expect(result.code).toBe("bad_request");
    expect(result.friendly).toBe("bad category header");
    expect(result.retryable).toBe(true);
  });
});

describe("mapDirectorError — non-gateway / loop-level failures", () => {
  it("an 'api' DirectorLoopError whose message isn't a gateway envelope maps to a generic service-away", () => {
    const result = mapDirectorError(new DirectorLoopError("api", "Failed to fetch"));
    expect(result.code).toBe("upstream_error");
    expect(result.retryable).toBe(true);
  });

  it("'no-storyboard' maps to a retryable, plain-language message (no raw validation errors leaked)", () => {
    const result = mapDirectorError(new DirectorLoopError("no-storyboard", "internal validator detail"));
    expect(result.code).toBe("no_storyboard");
    expect(result.retryable).toBe(true);
    expect(result.friendly).not.toContain("internal validator detail");
  });

  it("'max-rounds' maps to a retryable, plain-language message", () => {
    const result = mapDirectorError(new DirectorLoopError("max-rounds", "round limit reached"));
    expect(result.code).toBe("max_rounds");
    expect(result.retryable).toBe(true);
  });

  it("a plain Error (not a DirectorLoopError) surfaces its own message as a last resort", () => {
    const result = mapDirectorError(new Error("something unexpected"));
    expect(result.code).toBe("unknown");
    expect(result.friendly).toBe("something unexpected");
    expect(result.retryable).toBe(true);
  });

  it("a non-Error thrown value gets a generic, non-crashing fallback", () => {
    const result = mapDirectorError("just a string");
    expect(result.code).toBe("unknown");
    expect(result.friendly.length).toBeGreaterThan(0);
    expect(result.retryable).toBe(true);
  });
});
