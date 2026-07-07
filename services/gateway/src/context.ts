/**
 * Shared Hono context-variable shape. Set once per request by app.ts's
 * surface-tagging middleware and sessions.ts's requireSession; read by
 * anything downstream (csrf.ts, proxy.ts, admin.ts, ...).
 */
import type { AdminUser } from "@wizz/contracts";

export type Surface = "public" | "admin";

export interface Vars {
  surface: Surface;
  user?: AdminUser;
  sessionTokenHash?: string;
}
