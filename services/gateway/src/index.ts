/**
 * wizz gateway entry point — env parse, DB open+migrate, build the two
 * per-surface apps, serve() twice, graceful SIGTERM shutdown. Everything
 * else lives in its own module; see the README's module map.
 */
import { serve } from "@hono/node-server";
import { RATE_LIMITS } from "@wizz/contracts";
import { buildAppDeps, createApp } from "./app";
import { ensureBootstrapInvite, openDb, startSessionGc } from "./db";
import { loadEnv, missingProviderKeys } from "./env";
import { createLoginLimiter, createRateLimiter } from "./rate-limit";

const env = loadEnv();

const missing = missingProviderKeys(env);
if (missing.length > 0) {
  console.warn(`[wizz-gateway] missing provider key env vars (proxy calls to these providers will fail): ${missing.join(", ")}`);
}

const db = openDb(env.dbPath);
ensureBootstrapInvite(db);
const sessionGcTimer = startSessionGc(db);

const deps = buildAppDeps(db, env, {
  loginLimiter: createLoginLimiter(),
  proxyUserLimiter: createRateLimiter(RATE_LIMITS.perUserPerMinute),
  proxyIpLimiter: createRateLimiter(RATE_LIMITS.perIpPerMinute),
  telemetryLimiter: createRateLimiter(RATE_LIMITS.telemetryPerUserPerMinute),
});

const publicApp = createApp("public", deps);
const adminApp = createApp("admin", deps);

const publicServer = serve({ fetch: publicApp.fetch, port: env.portPublic, hostname: "127.0.0.1" }, (info) => {
  console.log(`[wizz-gateway] public listener on http://127.0.0.1:${info.port}`);
});
const adminServer = serve({ fetch: adminApp.fetch, port: env.portAdmin, hostname: "127.0.0.1" }, (info) => {
  console.log(`[wizz-gateway] admin listener on http://127.0.0.1:${info.port}`);
});

function shutdown(signal: string): void {
  console.log(`[wizz-gateway] ${signal} received, shutting down`);
  clearInterval(sessionGcTimer);
  let pending = 2;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) {
      db.close();
      process.exit(0);
    }
  };
  publicServer.close(done);
  adminServer.close(done);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
