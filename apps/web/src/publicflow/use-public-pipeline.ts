/**
 * WS-E IMPLEMENTS THIS (placeholder is inert but compiles): the real hook
 * wraps the perception pipeline exactly as the lab runs it — decode + shots
 * + local captions + whisper(+VAD) per the preset's labSettings, rolling
 * windows for long clips, dossier cache reuse — surfacing only the public
 * vocabulary in types.ts. Cloud STT (when toggled on) VAD-gates uploads:
 * speech regions only, timestamps remapped to absolute clip time.
 */
import { useMemo } from "react";
import type { PublicPipeline, PublicRunConfig } from "./types";

export function usePublicPipeline(config: PublicRunConfig | null): PublicPipeline {
  return useMemo<PublicPipeline>(
    () => ({
      clips: [],
      addFiles: () => {},
      removeClip: () => {},
      retryClip: () => {},
      allReady: false,
      batch: null,
      cloudSTT: config?.cloudSTTDefaultOn ?? true,
      setCloudSTT: () => {},
      modelPrep: null,
      cap: config?.cap ?? { maxClips: 25, maxTotalSeconds: 3600 },
      lastRefusal: null,
    }),
    [config],
  );
}
