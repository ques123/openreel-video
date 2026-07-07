/**
 * Env parsing for the wizz gateway. Production reads from
 * /etc/wizz/gateway.env (systemd EnvironmentFile) — see WIZZ_ENV_KEYS in
 * @wizz/contracts for the production contract. Local dev/tests get sane
 * defaults so `pnpm dev` and `pnpm test` work with zero setup, matching
 * localhost:5173 (vite's default) so WS-D can run against this gateway
 * without any env file at all.
 */
import { WIZZ_GATEWAY_PORT_ADMIN, WIZZ_GATEWAY_PORT_PUBLIC } from "@wizz/contracts";

export interface GatewayEnv {
  dbPath: string;
  portPublic: number;
  portAdmin: number;
  publicOrigin: string;
  adminOrigin: string;
  openaiKey: string;
  openrouterKey: string;
  groqKey: string;
  sunoKey: string;
  /**
   * Dev/test-only escape hatch: mark the session cookie Secure even when the
   * request didn't arrive over https (see sessions.ts's isHttpsRequest).
   * NOT part of the production env contract (WIZZ_ENV_KEYS) — production
   * never sets this; local dev over plain http needs it or browsers refuse
   * to store the cookie at all.
   */
  insecureCookies: boolean;
  /** Optional override for AdminHealth.version; falls back to package.json's version. */
  buildVersion: string | undefined;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** DEV_DEFAULT_ORIGIN matches vite's default dev server so WS-D/WS-C can run against this gateway unconfigured. */
const DEV_DEFAULT_ORIGIN = "http://localhost:5173";

export function loadEnv(source: NodeJS.ProcessEnv = process.env): GatewayEnv {
  return {
    dbPath: source.WIZZ_DB_PATH || "./dev.db",
    portPublic: intFromEnv(source.WIZZ_PORT_PUBLIC, WIZZ_GATEWAY_PORT_PUBLIC),
    portAdmin: intFromEnv(source.WIZZ_PORT_ADMIN, WIZZ_GATEWAY_PORT_ADMIN),
    publicOrigin: source.WIZZ_PUBLIC_ORIGIN || DEV_DEFAULT_ORIGIN,
    adminOrigin: source.WIZZ_ADMIN_ORIGIN || DEV_DEFAULT_ORIGIN,
    openaiKey: source.WIZZ_OPENAI_KEY || "",
    openrouterKey: source.WIZZ_OPENROUTER_KEY || "",
    groqKey: source.WIZZ_GROQ_KEY || "",
    sunoKey: source.WIZZ_SUNO_KEY || "",
    insecureCookies: source.WIZZ_INSECURE_COOKIES === "1",
    buildVersion: source.WIZZ_BUILD_VERSION || undefined,
  };
}

/** Keys that are required in production; missing ones just log a warning (dev without real keys still boots). */
export function missingProviderKeys(env: GatewayEnv): string[] {
  const missing: string[] = [];
  if (!env.openaiKey) missing.push("WIZZ_OPENAI_KEY");
  if (!env.openrouterKey) missing.push("WIZZ_OPENROUTER_KEY");
  if (!env.groqKey) missing.push("WIZZ_GROQ_KEY");
  if (!env.sunoKey) missing.push("WIZZ_SUNO_KEY");
  return missing;
}
