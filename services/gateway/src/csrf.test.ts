import { describe, expect, it } from "vitest";
import { ADMIN_ORIGIN, PUBLIC_ORIGIN, setupTest } from "./test-helpers";

describe("CSRF origin check", () => {
  it("rejects a mutating request with no Origin header with bad_origin", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.code).toBe("bad_origin");
  });

  it("rejects a mutating request with a mismatched Origin", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect((await res.json() as any).error.code).toBe("bad_origin");
  });

  it("accepts a mutating request whose Origin exactly matches the listener's configured origin", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/logout", { method: "POST", headers: { origin: PUBLIC_ORIGIN } });
    expect(res.status).toBe(204);
  });

  it("does not require an Origin header on GET (non-mutating) requests", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/session"); // no origin header at all
    expect(res.status).toBe(401); // auth_required, not bad_origin — CSRF never fired
  });

  it("the admin listener checks against WIZZ_ADMIN_ORIGIN, not the public origin", async () => {
    const { adminApp } = setupTest();
    const wrongOrigin = await adminApp.request("/api/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ maxUses: 1 }),
    });
    expect((await wrongOrigin.json() as any).error.code).toBe("bad_origin");

    const rightOrigin = await adminApp.request("/api/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ADMIN_ORIGIN },
      body: JSON.stringify({ maxUses: 1 }),
    });
    expect(rightOrigin.status).toBe(200);
  });

  it("never emits any Access-Control-* (CORS) header on any response", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/auth/session", { headers: { origin: "https://anywhere.example" } });
    for (const [key] of res.headers.entries()) {
      expect(key.toLowerCase().startsWith("access-control-")).toBe(false);
    }
  });
});
