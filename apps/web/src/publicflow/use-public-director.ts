/**
 * WS-E IMPLEMENTS THIS (placeholder is inert but compiles): the real hook
 * runs the core director loop (candidates prompt mode, preset-pinned model,
 * preset transcriptSource) through the metered gateway — same construction
 * as the lab's use-director but with NO experiments recording and the
 * activity stream reduced to the public narrative (search queries verbatim).
 * GatewayError codes map to the friendly phase errors per contracts §7.
 */
import { useMemo } from "react";
import type { PublicDirector, PublicRunConfig } from "./types";

export function usePublicDirector(
  _config: PublicRunConfig | null,
  _dossiers: unknown,
): PublicDirector {
  return useMemo<PublicDirector>(
    () => ({
      phase: { kind: "idle" },
      generate: () => {},
      refine: () => {},
      cancel: () => {},
      reset: () => {},
    }),
    [],
  );
}
