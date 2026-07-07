/**
 * gateway.ts: gatewayFetch's error-mapping is the contract every typed
 * helper depends on — a non-2xx WizzApiError envelope becomes a matching
 * GatewayError, a non-JSON/absent envelope becomes upstream_error, a 204
 * resolves to undefined, and a fetch() that never reaches a Response
 * (network failure) still surfaces as a GatewayError rather than a raw
 * rejection. A few typed helpers get a request-shaping smoke test
 * (credentials always included; query-string building; sendTelemetry never
 * throws).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminListUsers,
  GatewayError,
  gatewayFetch,
  getSession,
  logout,
  sendTelemetry,
  signup,
  type FetchInit,
} from "./gateway";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface MockResponseInit {
  ok: boolean;
  status: number;
  contentType?: string | null;
  jsonBody?: unknown;
  textBody?: string;
}

function mockResponse(init: MockResponseInit) {
  return {
    ok: init.ok,
    status: init.status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? (init.contentType ?? null) : null,
    },
    json: async () => {
      if (init.jsonBody === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return init.jsonBody;
    },
    text: async () => init.textBody ?? "",
  };
}

interface SentRequest {
  url: string;
  init: FetchInit;
}

function stubFetch(respond: (req: SentRequest) => ReturnType<typeof mockResponse>): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: FetchInit = {}) => {
      const req = { url, init };
      sent.push(req);
      return respond(req);
    }),
  );
  return sent;
}

describe("gatewayFetch", () => {
  it("resolves the parsed JSON body on a 2xx JSON response", async () => {
    stubFetch(() =>
      mockResponse({ ok: true, status: 200, contentType: "application/json", jsonBody: { hello: "world" } }),
    );
    await expect(gatewayFetch("/api/quota")).resolves.toEqual({ hello: "world" });
  });

  it("always adds credentials: include, even when the caller didn't ask for it", async () => {
    const sent = stubFetch(() =>
      mockResponse({ ok: true, status: 200, contentType: "application/json", jsonBody: {} }),
    );
    await gatewayFetch("/api/quota");
    expect(sent[0].init.credentials).toBe("include");
  });

  it("overrides a caller-supplied credentials value (always 'include')", async () => {
    const sent = stubFetch(() =>
      mockResponse({ ok: true, status: 200, contentType: "application/json", jsonBody: {} }),
    );
    await gatewayFetch("/api/quota", { credentials: "omit" });
    expect(sent[0].init.credentials).toBe("include");
  });

  it("resolves undefined for a 204 No Content response", async () => {
    stubFetch(() => mockResponse({ ok: true, status: 204 }));
    await expect(gatewayFetch("/api/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("maps a non-2xx WizzApiError envelope to a matching GatewayError", async () => {
    stubFetch(() =>
      mockResponse({
        ok: false,
        status: 402,
        contentType: "application/json",
        jsonBody: {
          error: {
            code: "quota_exceeded",
            message: "director token budget spent for today",
            category: "directorTokens",
            resetsAt: "2026-07-08T00:00:00.000Z",
          },
        },
      }),
    );
    await expect(gatewayFetch("/api/quota")).rejects.toMatchObject({
      name: "GatewayError",
      code: "quota_exceeded",
      status: 402,
      message: "director token budget spent for today",
      category: "directorTokens",
      resetsAt: "2026-07-08T00:00:00.000Z",
    });
  });

  it("maps a rate_limited envelope's retryAfterS through", async () => {
    stubFetch(() =>
      mockResponse({
        ok: false,
        status: 429,
        contentType: "application/json",
        jsonBody: { error: { code: "rate_limited", message: "slow down", retryAfterS: 12 } },
      }),
    );
    await expect(gatewayFetch("/api/quota")).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterS: 12,
    });
  });

  it("maps a non-2xx HTML body (no envelope) to upstream_error", async () => {
    stubFetch(() =>
      mockResponse({ ok: false, status: 502, contentType: "text/html", textBody: "<html>Bad Gateway</html>" }),
    );
    await expect(gatewayFetch("/api/quota")).rejects.toMatchObject({
      name: "GatewayError",
      code: "upstream_error",
      status: 502,
    });
  });

  it("maps a non-2xx response whose JSON body is unparseable to upstream_error", async () => {
    stubFetch(() => mockResponse({ ok: false, status: 500, contentType: "application/json" }));
    await expect(gatewayFetch("/api/quota")).rejects.toMatchObject({
      code: "upstream_error",
      status: 500,
    });
  });

  it("maps a 2xx non-JSON response (e.g. a dev SPA fallback) to upstream_error instead of a raw parse error", async () => {
    stubFetch(() => mockResponse({ ok: true, status: 200, contentType: "text/html", textBody: "<!doctype html>" }));
    await expect(gatewayFetch("/api/admin/health")).rejects.toMatchObject({
      code: "upstream_error",
      status: 200,
    });
  });

  it("maps a network-level fetch failure (no Response at all) to upstream_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(gatewayFetch("/api/quota")).rejects.toMatchObject({
      name: "GatewayError",
      code: "upstream_error",
    });
  });
});

describe("GatewayError", () => {
  it("is a real Error instance carrying the WizzApiError fields", () => {
    const err = new GatewayError({ code: "auth_required", status: 401, message: "please sign in" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GatewayError");
    expect(err.message).toBe("please sign in");
    expect(err.code).toBe("auth_required");
    expect(err.status).toBe(401);
  });
});

describe("typed helper shaping", () => {
  it("signup posts a JSON body to /api/auth/signup", async () => {
    const sent = stubFetch(() =>
      mockResponse({
        ok: true,
        status: 200,
        contentType: "application/json",
        jsonBody: { user: { id: "1", email: "a@b.com", createdAt: "now" } },
      }),
    );
    await signup({ inviteCode: "WZ-AAAA-BBBB", email: "a@b.com", password: "password1" });
    expect(sent[0].url).toBe("/api/auth/signup");
    expect(sent[0].init.method).toBe("POST");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({
      inviteCode: "WZ-AAAA-BBBB",
      email: "a@b.com",
      password: "password1",
    });
  });

  it("getSession GETs /api/auth/session", async () => {
    const sent = stubFetch(() =>
      mockResponse({
        ok: true,
        status: 200,
        contentType: "application/json",
        jsonBody: { user: { id: "1", email: "a@b.com", createdAt: "now" } },
      }),
    );
    await getSession();
    expect(sent[0].url).toBe("/api/auth/session");
  });

  it("logout POSTs to /api/auth/logout and resolves on 204", async () => {
    const sent = stubFetch(() => mockResponse({ ok: true, status: 204 }));
    await expect(logout()).resolves.toBeUndefined();
    expect(sent[0].init.method).toBe("POST");
  });

  it("adminListUsers appends ?q= only when a query is given", async () => {
    const sent = stubFetch(() =>
      mockResponse({ ok: true, status: 200, contentType: "application/json", jsonBody: { users: [] } }),
    );
    await adminListUsers();
    await adminListUsers("chris");
    expect(sent[0].url).toBe("/api/admin/users");
    expect(sent[1].url).toBe("/api/admin/users?q=chris");
  });

  it("sendTelemetry never throws, even when the gateway call fails", async () => {
    stubFetch(() =>
      mockResponse({
        ok: false,
        status: 500,
        contentType: "application/json",
        jsonBody: { error: { code: "upstream_error", message: "boom" } },
      }),
    );
    expect(() => sendTelemetry("session_start", { clipCount: 3 })).not.toThrow();
    // Let the swallowed rejection's microtask settle so it can't surface as
    // an unhandled rejection in the test runner.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
