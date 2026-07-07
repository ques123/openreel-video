/**
 * Request-shaping smoke test for the one gateway.ts gap this wave fills
 * locally (see file header) — mirrors services/gateway.test.ts's own
 * stubFetch convention rather than mocking the gateway module, so this
 * exercises the real gatewayFetch plumbing (credentials, JSON body) too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchInit } from "../../services/gateway";
import { adminCreatePreset } from "./gateway-admin-extra";

interface SentRequest {
  url: string;
  init: FetchInit;
}

function stubFetch(jsonBody: unknown): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: FetchInit = {}) => {
      sent.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
        json: async () => jsonBody,
        text: async () => JSON.stringify(jsonBody),
      };
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adminCreatePreset", () => {
  it("POSTs to /api/admin/presets with a JSON body and credentials included", async () => {
    const sent = stubFetch({ preset: { id: "abc" } });
    await adminCreatePreset({ name: "new preset" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/admin/presets");
    expect(sent[0].init.method).toBe("POST");
    expect(sent[0].init.credentials).toBe("include");
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ name: "new preset" });
  });

  it("defaults to an empty body when called with no arguments", async () => {
    const sent = stubFetch({ preset: { id: "abc" } });
    await adminCreatePreset();
    expect(JSON.parse(sent[0].init.body as string)).toEqual({});
  });

  it("resolves the parsed { preset } response", async () => {
    stubFetch({ preset: { id: "xyz", name: "wizz launch preset" } });
    await expect(adminCreatePreset()).resolves.toEqual({ preset: { id: "xyz", name: "wizz launch preset" } });
  });
});
