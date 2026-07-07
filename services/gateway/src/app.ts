/**
 * Assembles one Hono app per listener surface. Both surfaces mount the exact
 * same route set (contracts §0: "two listeners, one Hono app") — the only
 * per-surface differences are: (a) /api/admin/* 403s admin_only outright on
 * "public" before anything else runs, (b) the CSRF Origin check uses that
 * surface's configured origin, and (c) the proxy's per-user/per-IP rate
 * limits only apply on "public" (see proxy.ts).
 */
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { DEFAULT_PUBLISHED_PRESET } from "@wizz/contracts";
import { registerAdminRoutes } from "./admin";
import { registerAuthRoutes } from "./auth";
import type { Surface, Vars } from "./context";
import { csrfMiddleware } from "./csrf";
import { PresetCache, SettingsCache } from "./db";
import { errorResponse, toErrorResponse } from "./errors";
import type { GatewayEnv } from "./env";
import { registerProductRoutes } from "./product";
import { registerProxyRoutes } from "./proxy";
import { QuotaStore } from "./quota";
import type { RateLimiter } from "./rate-limit";
import { registerTelemetryRoutes } from "./telemetry";

export interface AppDeps {
  db: Database.Database;
  env: GatewayEnv;
  settings: SettingsCache;
  presets: PresetCache;
  quotaStore: QuotaStore;
  loginLimiter: RateLimiter;
  proxyUserLimiter: RateLimiter;
  proxyIpLimiter: RateLimiter;
  telemetryLimiter: RateLimiter;
  fetchImpl: typeof fetch;
}

/** Builds every shared, process-wide dependency from a db+env pair — index.ts and tests both use this. */
export function buildAppDeps(
  db: Database.Database,
  env: GatewayEnv,
  limiters: {
    loginLimiter: RateLimiter;
    proxyUserLimiter: RateLimiter;
    proxyIpLimiter: RateLimiter;
    telemetryLimiter: RateLimiter;
  },
  fetchImpl: typeof fetch = fetch,
): AppDeps {
  const settings = new SettingsCache(db);
  const presets = new PresetCache(db, settings, DEFAULT_PUBLISHED_PRESET);
  return {
    db,
    env,
    settings,
    presets,
    quotaStore: new QuotaStore(db),
    ...limiters,
    fetchImpl,
  };
}

export function createApp(surface: Surface, deps: AppDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  const origin = surface === "public" ? deps.env.publicOrigin : deps.env.adminOrigin;

  app.use("*", async (c, next) => {
    c.set("surface", surface);
    await next();
  });

  // Admin gate MUST run before the global CSRF check so the public listener always answers admin_only,
  // with no Origin-header dependence at all (registered first == executes first for overlapping paths).
  app.use("/api/admin/*", async (c, next) => {
    if (surface === "public") return errorResponse(c, "admin_only");
    await next();
  });

  app.use("*", csrfMiddleware(origin));

  registerAuthRoutes(app, { db: deps.db, env: deps.env, loginLimiter: deps.loginLimiter });
  registerProductRoutes(app, {
    db: deps.db,
    env: deps.env,
    settings: deps.settings,
    presets: deps.presets,
    quotaStore: deps.quotaStore,
  });
  registerProxyRoutes(app, {
    db: deps.db,
    env: deps.env,
    settings: deps.settings,
    quotaStore: deps.quotaStore,
    userLimiter: deps.proxyUserLimiter,
    ipLimiter: deps.proxyIpLimiter,
    fetchImpl: deps.fetchImpl,
  });
  registerTelemetryRoutes(app, { db: deps.db, env: deps.env, limiter: deps.telemetryLimiter });
  registerAdminRoutes(app, { db: deps.db, settings: deps.settings, presets: deps.presets });

  app.notFound((c) => errorResponse(c, "not_found"));
  app.onError((err, c) => toErrorResponse(err, c));

  return app;
}
