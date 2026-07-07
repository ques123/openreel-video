/**
 * The two read-only, session-gated "what should the public app show" routes:
 * GET /api/preset and GET /api/quota. Both are hot-path (hit on every page
 * load / poll), hence the settings/preset caches threaded in from app.ts.
 */
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { PresetResponse, QuotaStatus } from "@wizz/contracts";
import type { Vars } from "./context";
import type { PresetCache, SettingsCache } from "./db";
import type { GatewayEnv } from "./env";
import { WizzError } from "./errors";
import { buildQuotaStatus, type QuotaStore } from "./quota";
import { sessionOrSyntheticAdmin } from "./sessions";

export interface ProductDeps {
  db: Database.Database;
  env: GatewayEnv;
  settings: SettingsCache;
  presets: PresetCache;
  quotaStore: QuotaStore;
}

export function registerProductRoutes(app: Hono<{ Variables: Vars }>, deps: ProductDeps): void {
  app.get("/api/preset", sessionOrSyntheticAdmin(deps.db, deps.env), (c) => {
    const settings = deps.settings.get();
    const preset = deps.presets.getActive();
    return c.json({ preset, footageCap: settings.footageCap } satisfies PresetResponse, 200);
  });

  app.get("/api/quota", sessionOrSyntheticAdmin(deps.db, deps.env), (c) => {
    const user = c.get("user");
    if (!user) throw new WizzError("auth_required");
    const settings = deps.settings.get();
    const status = buildQuotaStatus(deps.quotaStore, settings, user.id, user.quotaOverrides);
    return c.json(status satisfies QuotaStatus, 200);
  });
}
