/**
 * The public bench's engine: a LEAN orchestrator built directly on
 * @openreel/core's FunnelOrchestrator, rather than wrapping the admin lab's
 * apps/web/src/pages/lab/use-perception-lab.ts. See the file-level report for
 * the full rationale; in short:
 *
 *  1. The lab hook's cloud-transcribe auto-queue is hardwired to the UNGATED
 *     `transcribeCloudPcm` with no seam to inject the REQUIRED VAD-gated
 *     path, and doesn't expose `saveDossier`/the orchestrator externally —
 *     wrapping it would either silently ship the un-gated upload behavior
 *     this whole feature exists to replace, or require editing a file
 *     outside this workstream's ownership (pages/lab/**).
 *  2. It also imports services/cloud-vision.ts for its enhanceClip path (the
 *     admin-only "enhance" concept the public preset disables entirely) and
 *     carries selector-tuning/search-panel plumbing the public product has
 *     no surface for.
 *
 * A lean orchestrator gives full control over the public-only vocabulary
 * (human stage labels, honest batch ETA, footage cap) without fighting the
 * lab's LabClip shape, and keeps this file's only @openreel/core dependency
 * surface to FunnelOrchestrator + a handful of pure analysis helpers — no
 * admin-only module is ever imported.
 *
 * Pure state (event -> per-clip status, batch ETA, model prep, footage cap
 * math) lives in internal/pipeline-state.ts and is unit-tested there; this
 * file is the thin impure shell: owns the orchestrator instance, the file
 * registry, and the VAD-gated cloud-transcribe queue.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  computeAudioEnvelope,
  computeEnergyGateRegions,
  extractAudioPcm,
  FunnelOrchestrator,
  processVadRegions,
  templateQuery,
  type ClipDossier,
} from "@openreel/core";
import { DEFAULT_GLOBAL_SETTINGS } from "@wizz/contracts";
import { defaultLabSettings } from "../pages/lab/lab-settings-core";
import { CLOUD_CHUNK_S, transcribeCloudPcmGated } from "../services/groq-stt";
import { labSettingsOf } from "./preset-runtime";
import type { PublicClip, PublicPipeline, PublicRunConfig } from "./types";
import {
  applyModelEvent,
  checkMaxClipsCap,
  deriveAllReady,
  deriveBatch,
  deriveModelPrep,
  initialModelTrackerState,
  initialPipelineState,
  knownTotalSeconds,
  pipelineReducer,
  toPublicClip,
  wouldExceedMaxTotalSeconds,
  type RawClipState,
} from "./internal/pipeline-state";

/** Everything usePublicPipeline exposes: PublicPipeline (the frozen WS-D contract, structurally satisfied) plus the internal wiring usePublicDirector needs — a dossiers snapshot and local-embedding access for the director's search_shots tool, neither of which PublicPipeline itself carries. WS-D should pass this SAME object as usePublicDirector's second argument. */
export interface PublicPipelineHandle extends PublicPipeline {
  getDossiers(): ClipDossier[];
  embedQuery(query: string): Promise<Float32Array>;
}

let clipCounter = 0;
function newClipId(): string {
  clipCounter += 1;
  return `wizz-clip-${Date.now().toString(36)}-${clipCounter}`;
}

/**
 * Auto-queue eligibility, mirroring use-perception-lab.ts's
 * shouldAutoQueueCloudTranscribe: needs a dossier, must have SOME audio
 * (audioEnvelope !== null — undefined, "never computed", is NOT the same as
 * "confirmed no audio track" and stays eligible), no existing cloud
 * transcript, and never attempted before this session (auto-queue never
 * retries a failure).
 */
function shouldAutoQueueCloudTranscribe(clip: RawClipState, attempted: ReadonlySet<string>): boolean {
  return (
    clip.dossier !== null &&
    clip.dossier.audioEnvelope !== null &&
    !clip.dossier.cloudTranscript &&
    !attempted.has(clip.id)
  );
}

export function usePublicPipeline(config: PublicRunConfig | null): PublicPipelineHandle {
  const [state, dispatch] = useReducer(pipelineReducer, initialPipelineState);
  const [modelState, dispatchModel] = useReducer(applyModelEvent, initialModelTrackerState);
  const [cloudSTT, setCloudSTTState] = useState(() => config?.cloudSTTDefaultOn ?? true);
  const [lastRefusal, setLastRefusal] = useState<PublicPipeline["lastRefusal"]>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const orchestratorRef = useRef<FunnelOrchestrator | null>(null);
  const dossiersRef = useRef<Map<string, ClipDossier>>(new Map());
  const filesRef = useRef<Map<string, File>>(new Map());
  const clipsRef = useRef<RawClipState[]>(state.clips);
  const configRef = useRef(config);
  const cloudSTTRef = useRef(cloudSTT);
  const capRefusedRef = useRef<Set<string>>(new Set());

  const cloudQueueRef = useRef<string[]>([]);
  const cloudAttemptedRef = useRef<Set<string>>(new Set());
  const cloudProcessingRef = useRef(false);
  const cloudAbortControllersRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    clipsRef.current = state.clips;
  }, [state.clips]);
  configRef.current = config;
  cloudSTTRef.current = cloudSTT;

  const currentCap = useCallback(
    () => configRef.current?.cap ?? DEFAULT_GLOBAL_SETTINGS.footageCap,
    [],
  );
  const currentLabSettings = useCallback(
    () => (configRef.current ? labSettingsOf(configRef.current) : defaultLabSettings()),
    [],
  );

  const getOrchestrator = useCallback((): FunnelOrchestrator => {
    if (!orchestratorRef.current) {
      const orchestrator = new FunnelOrchestrator();
      orchestrator.onProgress((event) => {
        if (event.kind === "clip-done") dossiersRef.current.set(event.clipId, event.dossier);

        // Retroactive footage-cap enforcement: duration isn't known until
        // the funnel decodes far enough to report it (see PublicPipeline.cap's
        // doc) — a clip whose real duration would push the SESSION total over
        // the cap is cancelled here and reported via lastRefusal, same as a
        // synchronous maxClips refusal at addFiles() time.
        if (event.kind === "meta" && !capRefusedRef.current.has(event.clipId)) {
          const already = knownTotalSeconds(clipsRef.current, event.clipId);
          if (wouldExceedMaxTotalSeconds(already, event.durationS, currentCap())) {
            capRefusedRef.current.add(event.clipId);
            orchestrator.cancelClip(event.clipId);
            setLastRefusal({ reason: "maxTotalSeconds", count: 1 });
          }
        }

        dispatch({ type: "event", event, atMs: Date.now() });
        dispatchModel(event); // no-op (same state reference back) for non-model event kinds
      });
      orchestratorRef.current = orchestrator;
    }
    return orchestratorRef.current;
  }, [currentCap]);

  useEffect(() => {
    // Kick model downloads on mount so they overlap with the first drop —
    // the modelPrep strip's whole point (see deriveModelPrep's doc).
    getOrchestrator().warmUp("auto");
    const abortControllers = cloudAbortControllersRef.current;
    return () => {
      orchestratorRef.current?.dispose();
      orchestratorRef.current = null;
      cloudQueueRef.current = [];
      for (const controller of abortControllers.values()) controller.abort();
      abortControllers.clear();
    };
  }, [getOrchestrator]);

  // Tick the batch ETA forward in real time while anything is still
  // analyzing (mirrors the lab's storage-refresh interval pattern) — a
  // clip counts as "still analyzing" until it's truly ready (readyAtMs set,
  // which itself waits for captions to catch up) or has errored out.
  useEffect(() => {
    const anyActive = state.clips.some((c) => c.readyAtMs === null && c.outcome !== "error");
    if (!anyActive) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.clips]);

  /* ─────────────────────────── footage / addFiles ─────────────────────────── */

  const startAnalysis = useCallback(
    (id: string, file: File) => {
      const labSettings = currentLabSettings();
      getOrchestrator()
        .analyzeFile(file, "auto", id, {
          transcription: { model: labSettings.transcription.localModel, vad: labSettings.transcription.vad },
        })
        .catch(() => {
          // clip-error already updated the row via the progress listener.
        });
    },
    [getOrchestrator, currentLabSettings],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const { allowedCount, refusedByMaxClips } = checkMaxClipsCap(
        clipsRef.current.length,
        files.length,
        currentCap(),
      );
      if (refusedByMaxClips > 0) {
        setLastRefusal({ reason: "maxClips", count: refusedByMaxClips });
      }
      const accepted = files.slice(0, allowedCount);
      for (const file of accepted) {
        const id = newClipId();
        filesRef.current.set(id, file);
        dispatch({ type: "clip-added", id, fileName: file.name, atMs: Date.now() });
        startAnalysis(id, file);
      }
    },
    [currentCap, startAnalysis],
  );

  const removeClip = useCallback((id: string) => {
    orchestratorRef.current?.cancelClip(id);
    cloudQueueRef.current = cloudQueueRef.current.filter((qid) => qid !== id);
    cloudAbortControllersRef.current.get(id)?.abort();
    cloudAbortControllersRef.current.delete(id);
    dossiersRef.current.delete(id);
    filesRef.current.delete(id);
    dispatch({ type: "clip-removed", id });
  }, []);

  const retryClip = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id);
      if (!file) return;
      orchestratorRef.current?.cancelClip(id);
      dossiersRef.current.delete(id);
      cloudAttemptedRef.current.delete(id);
      dispatch({ type: "clip-added", id, fileName: file.name, atMs: Date.now() }); // resets the SAME row in place
      startAnalysis(id, file);
    },
    [startAnalysis],
  );

  /* ─────────────────────── VAD-gated cloud transcription queue ─────────────────────── */

  const runCloudTranscribeForClip = useCallback(
    async (file: File, dossier: ClipDossier, signal: AbortSignal) => {
      const pcm = await extractAudioPcm(file, { signal });
      if (!pcm || pcm.length === 0) return; // no audio track after all

      // Derive VAD regions from a FRESH envelope computed over the exact PCM
      // being uploaded — self-consistent regardless of whether the dossier's
      // OWN audioEnvelope (used by the selector) is present or still
      // "undefined" (never computed by a legacy/interrupted local pass).
      // Nothing here overwrites dossier.audioEnvelope.
      const envelope = computeAudioEnvelope(pcm, 16000);
      const rawRegions = computeEnergyGateRegions(envelope);
      const regions = processVadRegions(rawRegions, {
        totalDurationS: pcm.length / 16000,
        maxRegionS: CLOUD_CHUNK_S,
      });

      const result = await transcribeCloudPcmGated(pcm, regions, { signal });
      if (signal.aborted) return;

      // In-place mutation + saveDossier is the existing convention
      // (applyCloudResults / the lab's cloudTranscript assignment) — the
      // SAME dossier object is held by dossiersRef and by this clip's
      // RawClipState, so the director's next getDossiers() call sees it.
      dossier.cloudTranscript = {
        model: result.model,
        segments: result.segments,
        words: result.words,
        billedSeconds: result.billedSeconds,
        costUSD: result.costUSD,
        ms: result.ms,
        transcribedAt: Date.now(),
      };
      await getOrchestrator().saveDossier(file, dossier);
    },
    [getOrchestrator],
  );

  const pumpCloudQueue = useCallback(() => {
    if (cloudProcessingRef.current) return;
    if (!cloudSTTRef.current) return; // toggle-off PAUSES the queue — items stay queued, not dropped
    const clipId = cloudQueueRef.current[0];
    if (!clipId) return;
    cloudQueueRef.current.shift();

    const clip = clipsRef.current.find((c) => c.id === clipId);
    const file = filesRef.current.get(clipId);
    if (!clip?.dossier || !file) {
      pumpCloudQueue(); // clip vanished (removed) between enqueue and its turn — skip
      return;
    }

    cloudProcessingRef.current = true;
    const controller = new AbortController();
    cloudAbortControllersRef.current.set(clipId, controller);
    runCloudTranscribeForClip(file, clip.dossier, controller.signal)
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.error(`[wizz] cloud transcription failed for clip "${clip.dossier?.fileName}":`, err);
        }
      })
      .finally(() => {
        cloudAbortControllersRef.current.delete(clipId);
        cloudProcessingRef.current = false;
        pumpCloudQueue();
      });
  }, [runCloudTranscribeForClip]);

  useEffect(() => {
    if (!cloudSTT) return;
    for (const clip of state.clips) {
      if (
        shouldAutoQueueCloudTranscribe(clip, cloudAttemptedRef.current) &&
        !cloudQueueRef.current.includes(clip.id)
      ) {
        cloudAttemptedRef.current.add(clip.id);
        cloudQueueRef.current.push(clip.id);
      }
    }
    pumpCloudQueue();
  }, [state.clips, cloudSTT, pumpCloudQueue]);

  const setCloudSTT = useCallback((on: boolean) => setCloudSTTState(on), []);

  /* ─────────────────────────── director-facing handle ─────────────────────────── */

  const getDossiers = useCallback(() => [...dossiersRef.current.values()], []);
  const embedQuery = useCallback(
    (query: string) => getOrchestrator().embedText(templateQuery(query), "auto"),
    [getOrchestrator],
  );

  /* ─────────────────────────── projections ─────────────────────────── */

  const clips = useMemo<PublicClip[]>(() => state.clips.map(toPublicClip), [state.clips]);
  const allReady = useMemo(() => deriveAllReady(state.clips), [state.clips]);
  const batch = useMemo(() => deriveBatch(state.clips, nowMs), [state.clips, nowMs]);
  const modelPrep = useMemo(() => deriveModelPrep(modelState), [modelState]);

  return {
    clips,
    addFiles,
    removeClip,
    retryClip,
    allReady,
    batch,
    cloudSTT,
    setCloudSTT,
    modelPrep,
    cap: config?.cap ?? DEFAULT_GLOBAL_SETTINGS.footageCap,
    lastRefusal,
    getDossiers,
    embedQuery,
  };
}
