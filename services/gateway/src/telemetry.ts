/**
 * POST /api/telemetry — coarse client events (no pixels, no transcripts, no
 * filenames; contracts §2). Session-required, 120/min/user.
 */
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { TELEMETRY_TYPES, type TelemetryEventBody } from "@wizz/contracts";
import type { Vars } from "./context";
import { WizzError } from "./errors";
import type { GatewayEnv } from "./env";
import type { RateLimiter } from "./rate-limit";
import { parseJsonBody } from "./request-utils";
import { requireSession } from "./sessions";
import { newId } from "./crypto-ids";

export interface TelemetryDeps {
  db: Database.Database;
  env: GatewayEnv;
  limiter: RateLimiter;
}

function isTelemetryType(value: unknown): value is TelemetryEventBody["type"] {
  return typeof value === "string" && (TELEMETRY_TYPES as readonly string[]).includes(value);
}

export function registerTelemetryRoutes(app: Hono<{ Variables: Vars }>, deps: TelemetryDeps): void {
  app.post("/api/telemetry", requireSession(deps.db, deps.env), async (c) => {
    const user = c.get("user");
    if (!user) throw new WizzError("auth_required");

    const limit = deps.limiter.check(`telemetry:${user.id}`);
    if (!limit.ok) throw new WizzError("rate_limited", undefined, { retryAfterS: limit.retryAfterS });

    const body = await parseJsonBody<Partial<TelemetryEventBody>>(c);
    if (!body || !isTelemetryType(body.type)) throw new WizzError("bad_request", "Unknown telemetry type.");

    deps.db
      .prepare("INSERT INTO telemetry_events (id, user_id, type, data, at) VALUES (?, ?, ?, ?, ?)")
      .run(newId(), user.id, body.type, body.data ? JSON.stringify(body.data) : null, new Date().toISOString());

    return c.body(null, 204);
  });
}
