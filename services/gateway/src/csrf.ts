/**
 * CSRF via same-site cookie + Origin check (no CORS headers are ever
 * emitted, anywhere, by construction — see app.ts). Contracts §2: every
 * mutating route requires an Origin header exactly equal to the listener's
 * configured origin, else 403 bad_origin.
 */
import type { MiddlewareHandler } from "hono";
import { WizzError } from "./errors";
import type { Vars } from "./context";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfMiddleware(expectedOrigin: string): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    if (MUTATING_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== expectedOrigin) throw new WizzError("bad_origin");
    }
    await next();
  };
}
