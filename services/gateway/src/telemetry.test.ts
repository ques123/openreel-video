import { describe, expect, it } from "vitest";
import { PUBLIC_ORIGIN, setupTest, signUpUser } from "./test-helpers";

describe("POST /api/telemetry", () => {
  it("accepts a known type, stores it, and returns 204", async () => {
    const { publicApp, db } = setupTest();
    const { cookie, userId } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie },
      body: JSON.stringify({ type: "generate_started", data: { clipCount: 5 } }),
    });
    expect(res.status).toBe(204);
    const row = db.prepare("SELECT type, data, user_id FROM telemetry_events").get() as {
      type: string;
      data: string;
      user_id: string;
    };
    expect(row.type).toBe("generate_started");
    expect(row.user_id).toBe(userId);
    expect(JSON.parse(row.data)).toEqual({ clipCount: 5 });
  });

  it("rejects an unknown type with bad_request", async () => {
    const { publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    const res = await publicApp.request("/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie },
      body: JSON.stringify({ type: "not_a_real_type" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("bad_request");
  });

  it("requires a session", async () => {
    const { publicApp } = setupTest();
    const res = await publicApp.request("/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ type: "session_start" }),
    });
    expect(res.status).toBe(401);
  });

  it("rate-limits to 120/min/user", async () => {
    const { publicApp, db } = setupTest();
    const { cookie } = await signUpUser(publicApp, db);
    const headers = { "content-type": "application/json", origin: PUBLIC_ORIGIN, cookie };
    const body = JSON.stringify({ type: "session_start" });
    let last: Response | undefined;
    for (let i = 0; i < 120; i += 1) {
      last = await publicApp.request("/api/telemetry", { method: "POST", headers, body });
    }
    expect(last!.status).toBe(204);
    const over = await publicApp.request("/api/telemetry", { method: "POST", headers, body });
    expect(over.status).toBe(429);
  });
});
