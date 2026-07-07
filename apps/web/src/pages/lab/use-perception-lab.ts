import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  applyCloudResults,
  blurryAnnotations,
  DEFAULT_SELECTOR_CONFIG,
  expandSpanCaptions,
  FunnelOrchestrator,
  planCloudFrames,
  searchShots,
  selectCandidates,
  templateQuery,
  type AudioEnvelope,
  type AudioEvent,
  type ClipDossier,
  type CloudScope,
  type FunnelProgressEvent,
  type InferenceDevice,
  type SearchHit,
  type SelectionResult,
  type SelectorConfig,
  type Shot,
  type TranscriptSegment,
} from "@openreel/core";
import { describeFramesCloud } from "../../services/cloud-vision";

export type ClipStatus = "analyzing" | "done" | "error" | "cancelled";

/** What one enhanceClip run ended as (drives the bulk-run failure summary). */
export type EnhanceOutcome = { ok: true } | { ok: false; error: string };

export interface LabClip {
  clipId: string;
  fileName: string;
  fileSize: number;
  /**
   * Proxy's file name when this clip was PAIRED at drop time (a DJI .LRF
   * sidecar dropped alongside its original video — see addFiles). Absent for
   * normal clips and ALSO for cache hits where only the original was
   * re-dropped this session — check dossier.analyzedFromProxy too.
   */
  proxyName?: string;
  status: ClipStatus;
  error?: string;
  /**
   * True when this analysis replaces a cached dossier invalidated by a
   * DOSSIER_VERSION bump — the UI labels it "re-analyzing (pipeline
   * updated)" instead of it looking like a brand-new clip.
   */
  staleReanalysis?: boolean;
  durationS: number;
  /** Non-null when quota forced partial analysis (covers [0, this]). */
  analyzedThroughS: number | null;
  width: number;
  height: number;
  decodeT: number; // current decode position, seconds
  /** OPFS ingest progress 0..1, or null once decoding starts. */
  ingestProgress: number | null;
  /**
   * Rolling-window ingest progress for long clips whose analysis needed more
   * than one OPFS scratch window. Undefined until the first "ingest-window"
   * event; cleared at clip-done.
   */
  ingestWindow?: { window: number; windows: number; analyzedThroughS: number };
  shots: Shot[];
  embeddedCount: number;
  /** Dense caption pass progress (0/0 until the pass starts). */
  captionsDone: number;
  captionsTotal: number;
  /** Cloud enhance run state (null = never started this session). */
  cloud: {
    busy: boolean;
    done: number;
    total: number;
    error: string | null;
    /**
     * Timeline frames skipped by a candidates-only enhance because they fell
     * outside every candidate shot's range (set at cloud-start; unset for a
     * normal, non-candidate-scoped run).
     */
    outOfCandidateRanges?: number;
  } | null;
  transcript: TranscriptSegment[];
  dossier: ClipDossier | null;
  /**
   * Loudness envelope/events from the audio pass. May arrive via a dedicated
   * "audio-signals" event OR already be present on the dossier at clip-done
   * (enrichment can fire either before or after the clip finishes). Absent
   * (undefined) = no signal has arrived yet; present-but-empty events = the
   * clip is quiet.
   */
  audioEnvelope?: AudioEnvelope | null;
  audioEvents?: AudioEvent[];
}

export interface ModelStatus {
  state: "idle" | "downloading" | "ready" | "error";
  device: InferenceDevice | null;
  loadMs: number;
  /** file -> [loaded, total] */
  files: Record<string, [number, number]>;
}

export interface LabState {
  clips: LabClip[];
  models: { embed: ModelStatus; whisper: ModelStatus; captioner: ModelStatus };
  search: {
    query: string;
    hits: SearchHit[];
    searching: boolean;
  };
}

/**
 * OPFS scratch quota telemetry (navigator.storage). Null until the first
 * estimate resolves, or permanently on browsers lacking the API (Safari).
 */
export interface StorageStatus {
  quotaBytes: number;
  usageBytes: number;
  persisted: boolean;
}

const initialModelStatus: ModelStatus = {
  state: "idle",
  device: null,
  loadMs: 0,
  files: {},
};

/** Exported for unit testing (a clean starting point for reducer tests). */
export const initialState: LabState = {
  clips: [],
  models: {
    embed: { ...initialModelStatus },
    whisper: { ...initialModelStatus },
    captioner: { ...initialModelStatus },
  },
  search: { query: "", hits: [], searching: false },
};

type Action =
  | {
      type: "clip-added";
      clipId: string;
      fileName: string;
      fileSize: number;
      /** Set when this clip is a DJI .LRF proxy pair (see addFiles). */
      proxyName?: string;
    }
  | { type: "clip-removed"; clipId: string }
  | { type: "event"; event: FunnelProgressEvent }
  | { type: "search-start"; query: string }
  | { type: "search-done"; query: string; hits: SearchHit[] }
  | { type: "search-clear" }
  | { type: "cloud-start"; clipId: string; total: number; outOfCandidateRanges?: number }
  | { type: "cloud-progress"; clipId: string; done: number; total: number }
  | { type: "cloud-done"; clipId: string }
  | { type: "cloud-error"; clipId: string; message: string };

function updateClip(
  state: LabState,
  clipId: string,
  update: (clip: LabClip) => LabClip,
): LabState {
  return {
    ...state,
    clips: state.clips.map((c) => (c.clipId === clipId ? update(c) : c)),
  };
}

/** Exported for unit testing (pure state transitions, no React needed). */
export function reducer(state: LabState, action: Action): LabState {
  switch (action.type) {
    case "clip-added":
      return {
        ...state,
        clips: [
          ...state.clips,
          {
            clipId: action.clipId,
            fileName: action.fileName,
            fileSize: action.fileSize,
            proxyName: action.proxyName,
            status: "analyzing",
            durationS: 0,
            analyzedThroughS: null,
            width: 0,
            height: 0,
            decodeT: 0,
            ingestProgress: null,
            ingestWindow: undefined,
            shots: [],
            embeddedCount: 0,
            captionsDone: 0,
            captionsTotal: 0,
            cloud: null,
            transcript: [],
            dossier: null,
            audioEnvelope: undefined,
            audioEvents: undefined,
          },
        ],
      };

    case "clip-removed":
      return { ...state, clips: state.clips.filter((c) => c.clipId !== action.clipId) };

    case "cloud-start":
      return updateClip(state, action.clipId, (c) => ({
        ...c,
        cloud: {
          busy: true,
          done: 0,
          total: action.total,
          error: null,
          outOfCandidateRanges: action.outOfCandidateRanges,
        },
      }));

    case "cloud-progress":
      return updateClip(state, action.clipId, (c) => ({
        ...c,
        cloud: {
          busy: true,
          done: action.done,
          total: action.total,
          error: null,
          outOfCandidateRanges: c.cloud?.outOfCandidateRanges,
        },
      }));

    case "cloud-done":
      return updateClip(state, action.clipId, (c) => ({
        ...c,
        cloud: {
          busy: false,
          done: 0,
          total: 0,
          error: null,
          outOfCandidateRanges: c.cloud?.outOfCandidateRanges,
        },
        // cloud captions were written into the dossier in place; new shot
        // array reference triggers re-render of captions everywhere.
        shots: [...c.shots],
      }));

    case "cloud-error":
      return updateClip(state, action.clipId, (c) => ({
        ...c,
        cloud: {
          busy: false,
          done: 0,
          total: 0,
          error: action.message,
          outOfCandidateRanges: c.cloud?.outOfCandidateRanges,
        },
      }));

    case "search-start":
      return { ...state, search: { query: action.query, hits: [], searching: true } };

    case "search-done":
      if (state.search.query !== action.query) return state;
      return { ...state, search: { query: action.query, hits: action.hits, searching: false } };

    case "search-clear":
      return { ...state, search: { query: "", hits: [], searching: false } };

    case "event": {
      const e = action.event;
      switch (e.kind) {
        case "meta":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            durationS: e.durationS,
            analyzedThroughS: e.analyzedThroughS,
            width: e.width,
            height: e.height,
          }));
        case "ingest-progress":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            ingestProgress: e.bytesTotal > 0 ? e.bytesDone / e.bytesTotal : 0,
          }));
        case "ingest-window":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            ingestWindow: {
              window: e.window,
              windows: e.windows,
              analyzedThroughS: e.analyzedThroughS,
            },
          }));
        case "decode-progress":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            decodeT: e.t,
            ingestProgress: null,
          }));
        case "shot":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            shots: [...c.shots, e.shot],
          }));
        case "shot-embedded":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            embeddedCount: c.embeddedCount + 1,
            // shot.embedding is set in place by the orchestrator; the new
            // array reference triggers re-render.
            shots: [...c.shots],
          }));
        case "shot-captioned":
          // shot.caption is set in place by the orchestrator; new array
          // reference triggers re-render (same pattern as shot-embedded).
          return updateClip(state, e.clipId, (c) => ({ ...c, shots: [...c.shots] }));
        case "dense-captions":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            captionsDone: e.done,
            captionsTotal: e.total,
          }));
        case "transcript":
          return updateClip(state, e.clipId, (c) => ({ ...c, transcript: e.segments }));
        case "audio-signals":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            audioEnvelope: e.envelope,
            audioEvents: e.events,
          }));
        case "clip-done":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            status: "done",
            dossier: e.dossier,
            decodeT: e.dossier.durationS,
            durationS: e.dossier.durationS,
            analyzedThroughS: e.dossier.analyzedThroughS,
            width: e.dossier.width,
            height: e.dossier.height,
            shots: e.dossier.shots,
            transcript: e.dossier.transcript,
            embeddedCount: e.dossier.shots.filter((s) => s.embedding).length,
            // audio enrichment can land before or after clip-done — prefer
            // whatever the dossier itself carries, falling back to whatever
            // an earlier "audio-signals" event already set on this clip.
            audioEnvelope: e.dossier.audioEnvelope ?? c.audioEnvelope ?? null,
            audioEvents: e.dossier.audioEvents ?? c.audioEvents,
            // Rolling-window ingest is over — the clip is fully analyzed.
            ingestWindow: undefined,
          }));
        case "cache-invalidated":
          return updateClip(state, e.clipId, (c) => ({ ...c, staleReanalysis: true }));
        case "clip-error":
          // A deliberate cancel is not an error — distinct status, no error
          // text (the message is just "cancelled").
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            status: e.cancelled ? "cancelled" : "error",
            error: e.cancelled ? undefined : e.message,
          }));
        case "model-progress": {
          const model = state.models[e.model];
          if (model.state === "ready") return state;
          return {
            ...state,
            models: {
              ...state.models,
              [e.model]: {
                ...model,
                state: "downloading",
                files: { ...model.files, [e.file]: [e.loaded, e.total] },
              },
            },
          };
        }
        case "model-ready":
          return {
            ...state,
            models: {
              ...state.models,
              [e.model]: {
                ...state.models[e.model],
                state: "ready",
                device: e.device,
                loadMs: e.loadMs,
              },
            },
          };
        default:
          return state;
      }
    }

    default:
      return state;
  }
}

let clipCounter = 0;

/**
 * TEST HOOK: pretend the OPFS quota budget is this many bytes, forcing the
 * rolling-window ingest path on small fixtures. Never set this in production
 * — it's a manual localStorage flag for exercising long-clip passes without
 * an actually-huge file. Forwarded verbatim to analyzeFile's opts.
 */
function readDebugIngestBudgetBytes(): number | undefined {
  try {
    const raw = localStorage.getItem("openreel:debug:ingest-budget");
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function usePerceptionLab(
  forceDevice: "auto" | InferenceDevice = "auto",
  /**
   * Effective SelectorConfig (tuned settings + any active style-preset
   * adjustment — see selector-settings.ts effectiveSelectorConfig) for the
   * selection memo below. Defaults to DEFAULT_SELECTOR_CONFIG so callers
   * (and reducer-level tests, which never touch this hook) don't have to
   * pass one.
   */
  selectorConfig: SelectorConfig = DEFAULT_SELECTOR_CONFIG,
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const orchestratorRef = useRef<FunnelOrchestrator | null>(null);
  const dossiersRef = useRef<Map<string, ClipDossier>>(new Map());
  /** clipId -> original File, for shot preview playback. */
  const filesRef = useRef<Map<string, File>>(new Map());
  const [storage, setStorage] = useState<StorageStatus | null>(null);

  /** Re-read the OPFS scratch quota estimate. Guarded — absent on Safari. */
  const refreshStorage = useCallback(() => {
    const estimate = navigator.storage?.estimate?.();
    if (!estimate) return;
    estimate
      .then((result) => {
        setStorage((prev) => ({
          quotaBytes: result.quota ?? 0,
          usageBytes: result.usage ?? 0,
          persisted: prev?.persisted ?? false,
        }));
      })
      .catch(() => undefined);
  }, []);

  const getOrchestrator = useCallback((): FunnelOrchestrator => {
    if (!orchestratorRef.current) {
      const orchestrator = new FunnelOrchestrator();
      orchestrator.onProgress((event) => {
        if (event.kind === "clip-done") {
          dossiersRef.current.set(event.clipId, event.dossier);
        }
        if (event.kind === "audio-signals") {
          // The orchestrator's own dossier object is usually the SAME
          // reference stashed here at clip-done, so it already carries this
          // data by the time the event fires. Only clip-done races it (an
          // enrichment pass finishing before the funnel does) — top up the
          // ref's object in that case so getDossiers()/selection reflect it.
          const dossier = dossiersRef.current.get(event.clipId);
          if (dossier && (!dossier.audioEnvelope || !dossier.audioEvents)) {
            dossier.audioEnvelope = event.envelope;
            dossier.audioEvents = event.events;
          }
        }
        if (event.kind === "clip-done" || event.kind === "clip-error") {
          // Scratch usage just changed materially (cleanup freed a window, or
          // an error aborted mid-ingest) — refresh the quota telemetry.
          refreshStorage();
        }
        dispatch({ type: "event", event });
      });
      orchestratorRef.current = orchestrator;
    }
    return orchestratorRef.current;
  }, [refreshStorage]);

  useEffect(() => {
    // Kick model downloads on mount so they overlap with the first decode.
    getOrchestrator().warmUp(forceDevice);
    return () => {
      orchestratorRef.current?.dispose();
      orchestratorRef.current = null;
    };
  }, [getOrchestrator, forceDevice]);

  useEffect(() => {
    // Best-effort request for persistent storage — many browsers grant it
    // silently based on site engagement (some prompt); Safari lacks the API
    // entirely. Fire-and-forget: the quota estimate below doesn't wait on it.
    const persisting = navigator.storage?.persist?.();
    if (persisting) {
      persisting
        .then((persisted) => {
          setStorage((prev) =>
            prev ? { ...prev, persisted } : { quotaBytes: 0, usageBytes: 0, persisted },
          );
        })
        .catch(() => undefined);
    }
    refreshStorage();
  }, [refreshStorage]);

  // Keep the quota estimate fresh while a clip is actively consuming scratch
  // space (rolling-window ingest can eat into it fast); idle otherwise.
  const anyAnalyzing = state.clips.some((c) => c.status === "analyzing");
  useEffect(() => {
    if (!anyAnalyzing) return;
    const id = setInterval(refreshStorage, 15_000);
    return () => clearInterval(id);
  }, [anyAnalyzing, refreshStorage]);

  const addFiles = useCallback(
    (files: File[]) => {
      const orchestrator = getOrchestrator();
      const debugIngestBudgetBytes = readDebugIngestBudgetBytes();

      // Pair DJI .LRF proxies with their original video by basename (case-
      // insensitive, final extension stripped) — WITHIN THIS DROP ONLY (no
      // cross-session or cross-drop matching). A pair becomes ONE clip: the
      // small .lrf is what gets decoded/analyzed, the original stays the
      // identity/playback/export source (see analyzeFile's identityFile
      // opt). An .lrf with no matching original in this drop is a valid
      // small video in its own right and analyzes normally, standing in for
      // itself.
      const basenameOf = (name: string) => {
        const dot = name.lastIndexOf(".");
        return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
      };
      const isLrf = (f: File) => f.name.toLowerCase().endsWith(".lrf");
      const originalByBasename = new Map<string, File>();
      for (const f of files) {
        if (!isLrf(f)) originalByBasename.set(basenameOf(f.name), f);
      }
      const proxyForOriginal = new Map<File, File>();
      for (const f of files) {
        if (!isLrf(f)) continue;
        const original = originalByBasename.get(basenameOf(f.name));
        if (original) proxyForOriginal.set(original, f);
      }
      const pairedProxies = new Set(proxyForOriginal.values());

      for (const file of files) {
        // A proxy consumed by the pairing below is emitted alongside its
        // original, not as its own clip.
        if (isLrf(file) && pairedProxies.has(file)) continue;

        clipCounter += 1;
        const clipId = `lab-clip-${Date.now().toString(36)}-${clipCounter}`;
        const proxy = proxyForOriginal.get(file);

        if (proxy) {
          filesRef.current.set(clipId, file);
          dispatch({
            type: "clip-added",
            clipId,
            fileName: file.name,
            fileSize: file.size,
            proxyName: proxy.name,
          });
          orchestrator
            .analyzeFile(proxy, forceDevice, clipId, { identityFile: file, debugIngestBudgetBytes })
            .catch(() => {
              // clip-error event already updated the row; swallow the rejection.
            });
        } else {
          filesRef.current.set(clipId, file);
          dispatch({ type: "clip-added", clipId, fileName: file.name, fileSize: file.size });
          orchestrator.analyzeFile(file, forceDevice, clipId, { debugIngestBudgetBytes }).catch(() => {
            // clip-error event already updated the row; swallow the rejection.
          });
        }
      }
    },
    [getOrchestrator, forceDevice],
  );

  const runSearch = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        dispatch({ type: "search-clear" });
        return;
      }
      dispatch({ type: "search-start", query: trimmed });
      try {
        const orchestrator = getOrchestrator();
        const queryEmbedding = await orchestrator.embedText(templateQuery(trimmed), forceDevice);
        const result = searchShots(queryEmbedding, [...dossiersRef.current.values()], 12);
        dispatch({ type: "search-done", query: trimmed, hits: result.hits });
      } catch (err) {
        console.error("[lab] search failed:", err);
        dispatch({ type: "search-done", query: trimmed, hits: [] });
      }
    },
    [getOrchestrator, forceDevice],
  );

  const getFile = useCallback((clipId: string) => filesRef.current.get(clipId) ?? null, []);

  /**
   * Cancel a clip's analysis (queued or in-flight). The clip lands in the
   * distinct "cancelled" status via the orchestrator's cancelled-flagged
   * clip-error event — see FunnelOrchestrator.cancelClip for the mid-flight
   * semantics (partial work discarded, scratch cleaned, queue unblocked).
   */
  const cancelClip = useCallback((clipId: string) => {
    orchestratorRef.current?.cancelClip(clipId);
  }, []);

  /**
   * Drop a clip from this session: cancels any in-flight analysis first,
   * then removes it from clip state, the dossier snapshot and the file map
   * (so selection/search/director stop seeing it). SESSION-ONLY semantics:
   * a dossier already persisted to IndexedDB stays cached there — it is
   * keyed by file identity, so re-dropping the same file is an instant
   * cache hit, and the storage panel's clear tools own actual eviction.
   */
  const removeClip = useCallback((clipId: string) => {
    orchestratorRef.current?.cancelClip(clipId);
    dossiersRef.current.delete(clipId);
    filesRef.current.delete(clipId);
    dispatch({ type: "clip-removed", clipId });
  }, []);

  /** Snapshot of all completed dossiers (for the director). */
  const getDossiers = useCallback(() => [...dossiersRef.current.values()], []);

  /** Embed a text query with the local text tower (for the director's search tool). */
  const embedQuery = useCallback(
    (query: string) => getOrchestrator().embedText(templateQuery(query), forceDevice),
    [getOrchestrator, forceDevice],
  );

  /**
   * Opt-in cloud vision enhance: sends the selected frames for one clip to
   * the OpenAI proxy and merges the returned descriptions into the dossier
   * (persisted, so it costs once per clip+scope). The ONLY path where pixels
   * leave the device — reachable only from the explicit Enhance button.
   */
  const enhanceClip = useCallback(
    async (
      clipId: string,
      scope: CloudScope,
      model?: string,
      opts?: { candidateShotIndexes?: Set<number> },
    ): Promise<EnhanceOutcome> => {
      const dossier = dossiersRef.current.get(clipId);
      const file = filesRef.current.get(clipId);
      if (!dossier || !file) return { ok: false, error: "clip not analyzed yet" };
      const { frames, blurrySkipped, outOfCandidateRanges, preMergeCount } = planCloudFrames(
        dossier,
        scope,
        opts,
      );
      if (frames.length === 0) {
        dispatch({ type: "cloud-error", clipId, message: "no frames available yet" });
        return { ok: false, error: "no frames available yet" };
      }
      dispatch({
        type: "cloud-start",
        clipId,
        total: frames.length,
        outOfCandidateRanges: outOfCandidateRanges > 0 ? outOfCandidateRanges : undefined,
      });
      try {
        const run = await describeFramesCloud(
          frames,
          (done, total) => dispatch({ type: "cloud-progress", clipId, done, total }),
          undefined,
          model,
        );
        // Span reps duplicate at their span end (so the prompt merge renders
        // the range); blur-gated frames get a free local annotation.
        const captions = [
          ...expandSpanCaptions(run.captions, frames),
          ...blurryAnnotations(blurrySkipped),
        ];
        applyCloudResults(dossier, scope, captions, {
          model: run.model,
          enhancedAt: Date.now(),
          framesSent: run.framesSent,
          framesFailed: run.framesFailed,
          ms: run.ms,
          promptTokens: run.promptTokens,
          completionTokens: run.completionTokens,
          // Cache-discount + merge-lever telemetry: how much of the prompt
          // the provider served from cache, and how many in-scope frames the
          // blur gate + similarity merge saved (preMergeCount vs framesSent).
          cachedTokens: run.cachedTokens,
          preMergeCount,
          // Absent-key convention (matches cachedTokens/preMergeCount's
          // additive rollout): only set when every usage-bearing batch in
          // the run reported a cost (see aggregateActualCostUSD) — an
          // incomplete run leaves this unset so display falls back to the
          // token×rate estimate instead of persisting a partial number.
          ...(run.actualCostUSD !== null ? { actualCostUSD: run.actualCostUSD } : {}),
        });
        await getOrchestrator().saveDossier(file, dossier);
        dispatch({ type: "cloud-done", clipId });
        return { ok: true };
      } catch (err) {
        console.error(`[lab] cloud enhance failed for "${dossier.fileName}":`, err);
        const message = err instanceof Error ? err.message : String(err);
        dispatch({ type: "cloud-error", clipId, message });
        return { ok: false, error: message };
      }
    },
    [getOrchestrator],
  );

  /**
   * The signal-stack selector's scoring/candidates over every completed
   * dossier — the ground truth the Signals panel, filmstrip badges, director
   * candidates-mode, and candidates-only enhance all read from. Recomputed
   * whenever the clips array is replaced (the reducer does this on every
   * event, including in-place mutations like shot-embedded/shot-captioned/
   * audio-signals that matter to scoring) OR whenever selectorConfig changes
   * (tuning panel edits, reset-to-defaults, or a style-preset swap) — the
   * whole point of the tuning UI is that this recomputes live. Swallows
   * core errors so a mid-flight core implementation can't crash the lab UI —
   * callers treat null as "not ready yet".
   */
  const selection = useMemo<SelectionResult | null>(() => {
    const dossiers = state.clips
      .filter((c) => c.status === "done" && c.dossier)
      .map((c) => c.dossier as ClipDossier);
    if (dossiers.length === 0) return null;
    try {
      return selectCandidates(dossiers, selectorConfig);
    } catch (err) {
      console.error("[lab] selectCandidates failed:", err);
      return null;
    }
  }, [state.clips, selectorConfig]);

  return {
    state,
    addFiles,
    runSearch,
    getFile,
    getDossiers,
    embedQuery,
    enhanceClip,
    cancelClip,
    removeClip,
    selection,
    storage,
  };
}
