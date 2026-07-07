/**
 * Direct, exhaustive proof of the WIZZ_ERROR_STATUS mapping (contracts §2:
 * "the tests must assert the full mapping") — every other test file exercises
 * individual codes incidentally; this one loops the whole WIZZ_ERROR_CODES
 * union so a future code/status added to the contract can't silently ship
 * unmapped here.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { WIZZ_ERROR_CODES, WIZZ_ERROR_STATUS, type WizzErrorCode } from "@wizz/contracts";
import { errorResponse, toErrorResponse, WizzError, wizzErrorBody } from "./errors";

describe("WIZZ_ERROR_STATUS mapping", () => {
  it("toErrorResponse (the app.onError path) maps every code to its documented status + echoes the code in the body", async () => {
    for (const code of WIZZ_ERROR_CODES) {
      const app = new Hono();
      app.onError((err, c) => toErrorResponse(err, c));
      app.get("/", () => {
        throw new WizzError(code);
      });
      const res = await app.request("/");
      expect(res.status, `code ${code}`).toBe(WIZZ_ERROR_STATUS[code]);
      const body = (await res.json()) as { error: { code: WizzErrorCode } };
      expect(body.error.code).toBe(code);
    }
  });

  it("errorResponse (the direct-call path used by the admin gate + notFound) maps every code identically", async () => {
    for (const code of WIZZ_ERROR_CODES) {
      const app = new Hono();
      app.get("/", (c) => errorResponse(c, code));
      const res = await app.request("/");
      expect(res.status, `code ${code}`).toBe(WIZZ_ERROR_STATUS[code]);
    }
  });

  it("every code has a non-empty default message", () => {
    for (const code of WIZZ_ERROR_CODES) {
      expect(wizzErrorBody(code).error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("wizzErrorBody extras", () => {
  it("carries category + resetsAt for quota_exceeded", () => {
    const body = wizzErrorBody("quota_exceeded", undefined, {
      category: "sttSeconds",
      resetsAt: "2026-07-08T00:00:00.000Z",
    });
    expect(body.error.category).toBe("sttSeconds");
    expect(body.error.resetsAt).toBe("2026-07-08T00:00:00.000Z");
  });

  it("carries retryAfterS for rate_limited", () => {
    const body = wizzErrorBody("rate_limited", undefined, { retryAfterS: 42 });
    expect(body.error.retryAfterS).toBe(42);
  });

  it("a custom message overrides the default", () => {
    const body = wizzErrorBody("bad_request", "specific reason");
    expect(body.error.message).toBe("specific reason");
  });
});

describe("toErrorResponse: unexpected (non-WizzError) exceptions", () => {
  it("still returns a well-formed JSON envelope at 500, without leaking the raw error", async () => {
    const app = new Hono();
    app.onError((err, c) => toErrorResponse(err, c));
    app.get("/", () => {
      throw new Error("something truly unexpected");
    });
    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBeTruthy();
    expect(body.error.message).not.toContain("truly unexpected"); // the raw error message never reaches the client
  });
});
