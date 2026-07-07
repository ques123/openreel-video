/**
 * A single extension over ../../services/gateway.ts's admin helpers: creating
 * a brand-new published preset (POST /api/admin/presets). That file's own
 * header comment defers exactly this ("add adminCreatePreset alongside the
 * real Presets page in Wave 2 if that's needed") — but THIS wave's file
 * ownership is scoped to apps/web/src/admin/** only (gateway.ts is
 * import-only, see docs/wizz-video-plan.md §WS-C wave-2 instructions), so
 * the helper is added here, built on the same exported `gatewayFetch`
 * primitive gateway.ts's own typed helpers use, rather than editing that
 * file. Every other admin route the Presets/Users/Usage/System sections need
 * was already present in gateway.ts.
 */
import type { PublishedPreset } from "@wizz/contracts";
import { gatewayFetch } from "../../services/gateway";

/**
 * POST /api/admin/presets — omit `body` (or pass `{}`) to create a fresh
 * copy of DEFAULT_PUBLISHED_PRESET; the server assigns a new id, version=1,
 * publishedAt=null, and merges any fields the body does supply over the
 * default (services/gateway/src/admin.ts `mergePresetFields`).
 */
export function adminCreatePreset(body: Partial<PublishedPreset> = {}): Promise<{ preset: PublishedPreset }> {
  return gatewayFetch("/api/admin/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
