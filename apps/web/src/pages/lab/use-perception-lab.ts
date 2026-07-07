import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  applyCloudResults,
  blurryAnnotations,
  DEFAULT_SELECTOR_CONFIG,
  expandSpanCaptions,
  extractAudioPcm,
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
import { transcribeCloudPcm } from "../../services/groq-stt";

export type ClipStatus = "analyzing" | "done" | "error" | "cancelled";

/**
 * Transcription settings threaded from the page (persisted prefs + the
 * SESSION-ONLY cloud consent toggle — audio leaving the device follows the
 * same per-session opt-in convention as cloud vision). Local whisper ALWAYS
 * runs; `cloudEnabled` only adds the Groq pass on top.
 */
export interface TranscriptionRunSettings {
  localModel: "base" | "large-v3-turbo";
  vad: boolean;
  cloudEnabled: boolean;
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionRunSettings = {
  localModel: "base",
  vad: true,
  cloudEnabled: false,
};

/** Per-clip cloud transcription progress (dossier.cloudTranscript holds the result). */
export type CloudTranscribeState =
  | { status: "queued" }
  | { status: "running" }
  | { status: "done" }
  | { status: "error"; error: string };

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
  /** Cloud transcription progress for this clip; absent = never attempted. */
  cloudTranscribe?: CloudTranscribeState;
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
  | { type: "cloud-error"; clipId: string; message: string }
  | { type: "cloud-transcribe-status"; clipId: string; state: CloudTranscribeState }
  | { type: "cloud-transcribe-done"; clipId: string; dossier: ClipDossier };

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

    case "cloud-transcribe-status":
      return updateClip(state, action.clipId, (c) => ({ ...c, cloudTranscribe: action.state }));

    case "cloud-transcribe-done":
      // The dossier's cloudTranscript field was already mutated in place
      // before this dispatch (same convention as applyCloudResults for cloud
      // vision) — reassigning it here explicitly is what actually triggers a
      // re-render of this row (updateClip always returns a new LabClip).
      return updateClip(state, action.clipId, (c) => ({
        ...c,
        cloudTranscribe: { status: "done" },
        dossier: action.dossier,
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

/**
 * Whether a clip should be auto-queued for cloud transcription. Exported for
 * unit testing (pure, no React needed). A clip leaves this pool permanently
 * once anything has been attempted this session (queued/running/done/error)
 * — auto-queue never retries a failure; that's what the manual
 * cloudTranscribeClip retry affordance is for.
 *
 *  - status must be "done" with a dossier (nothing to transcribe otherwise).
 *  - dossier.audioEnvelope === null means the audio pass ran and found NO
 *    audio track — skip. undefined means "never computed" (a legacy cache
 *    whose audio-signal enrichment hasn't landed yet) — that is NOT the same
 *    as "no audio," so it does NOT skip; the clip is queued optimistically
 *    and extractAudioPcm itself will find out for real.
 *  - a dossier that already carries a cloudTranscript (this session's run, or
 *    a cache hit from a previous session) is left alone.
 */
export function shouldAutoQueueCloudTranscribe(clip: LabClip): boolean {
  return (
    clip.status === "done" &&
    clip.dossier !== null &&
    clip.dossier.audioEnvelope !== null &&
    !clip.dossier.cloudTranscript &&
    !clip.cloudTranscribe
  );
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
  /**
   * Transcription prefs + session cloud consent. Local model/vad apply to
   * NEW analyses; cloudEnabled additionally queues a Groq transcription for
   * every done clip missing dossier.cloudTranscript (integration wave wires
   * the behavior — the default keeps existing callers/tests unchanged).
   */
  transcription: TranscriptionRunSettings = DEFAULT_TRANSCRIPTION_SETTINGS,
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const orchestratorRef = useRef<FunnelOrchestrator | null>(null);
  const dossiersRef = useRef<Map<string, ClipDossier>>(new Map());
  /** clipId -> original File, for shot preview playback. */
  const filesRef = useRef<Map<string, File>>(new Map());
  const [storage, setStorage] = useState<StorageStatus | null>(null);

  /**
   * Cloud transcription queue state. Concurrency 1 (cloudProcessingRef guards
   * it): items are FIFO; a manual retry/re-run (force: true) is exempt from
   * the cloudEnabled gate at dequeue time (see pumpCloudQueue) but still
   * shares this one queue, so it never overlaps another clip's cloud call.
   * transcriptionRef mirrors the `transcription` param on every render so
   * async queue code always reads the CURRENT toggle, not a stale closure.
   */
  const cloudQueueRef = useRef<Array<{ clipId: string; force: boolean }>>([]);
  const cloudProcessingRef = useRef(false);
  const cloudAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const transcriptionRef = useRef(transcription);
  transcriptionRef.current = transcription;

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
    // Snapshotting the Map reference here (not re-read from the ref inside
    // the cleanup below) satisfies react-hooks/exhaustive-deps; it's the
    // same object either way since nothing ever reassigns
    // cloudAbortControllersRef.current, only mutates its contents.
    const abortControllers = cloudAbortControllersRef.current;
    return () => {
      orchestratorRef.current?.dispose();
      orchestratorRef.current = null;
      // Stop any cloud-transcribe work in flight or waiting — nothing should
      // keep decoding/uploading audio after the lab unmounts.
      cloudQueueRef.current = [];
      for (const controller of abortControllers.values()) controller.abort();
      abortControllers.clear();
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

        // Local whisper model + VAD gating for this analyze call only —
        // applies to new analyses; a cache hit keeps whatever it was
        // originally analyzed with (see analyzeFile's opts doc in
        // funnel-orchestrator.ts).
        const transcriptionOpts = { model: transcription.localModel, vad: transcription.vad };

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
            .analyzeFile(proxy, forceDevice, clipId, {
              identityFile: file,
              debugIngestBudgetBytes,
              transcription: transcriptionOpts,
            })
            .catch(() => {
              // clip-error event already updated the row; swallow the rejection.
            });
        } else {
          filesRef.current.set(clipId, file);
          dispatch({ type: "clip-added", clipId, fileName: file.name, fileSize: file.size });
          orchestrator
            .analyzeFile(file, forceDevice, clipId, {
              debugIngestBudgetBytes,
              transcription: transcriptionOpts,
            })
            .catch(() => {
              // clip-error event already updated the row; swallow the rejection.
            });
        }
      }
    },
    [getOrchestrator, forceDevice, transcription.localModel, transcription.vad],
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
    // Drop it from the cloud-transcribe queue if it hasn't started yet, and
    // abort its in-flight extractAudioPcm/transcribeCloudPcm call if it has
    // — runCloudTranscribeItem's catch sees the AbortError and skips
    // gracefully (no error state, no dossier save for a clip that's gone).
    cloudQueueRef.current = cloudQueueRef.current.filter((item) => item.clipId !== clipId);
    cloudAbortControllersRef.current.get(clipId)?.abort();
    cloudAbortControllersRef.current.delete(clipId);
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

  /**
   * Process one queued clip: extract its audio (on this thread) and send it
   * through the Groq cloud pass, then persist the result into the dossier.
   * Concurrency is enforced by the caller (pumpCloudQueue) — this function
   * assumes it alone owns cloudProcessingRef for its duration.
   *
   * A clip whose File/dossier vanished (removed mid-queue) is skipped
   * silently — see removeClip, which also aborts this call if it's already
   * running for the clip being removed.
   */
  const runCloudTranscribeItem = useCallback(
    async (clipId: string) => {
      const file = filesRef.current.get(clipId);
      const dossier = dossiersRef.current.get(clipId);
      if (!file || !dossier) return; // removed/never-analyzed — nothing to do

      const controller = new AbortController();
      cloudAbortControllersRef.current.set(clipId, controller);
      dispatch({ type: "cloud-transcribe-status", clipId, state: { status: "running" } });

      try {
        const pcm = await extractAudioPcm(file, { signal: controller.signal });
        if (!pcm) throw new Error("no audio track found");
        const result = await transcribeCloudPcm(pcm, { signal: controller.signal });

        // Re-running an already-transcribed clip (manual retry, or a fresh
        // enable/disable/enable cycle) REPLACES the existing cloudTranscript
        // outright — there is no merge; the newest run is the one kept.
        dossier.cloudTranscript = { ...result, transcribedAt: Date.now() };
        await getOrchestrator().saveDossier(file, dossier);

        // The clip may have been removed while the save was in flight.
        if (!filesRef.current.has(clipId)) return;
        dispatch({ type: "cloud-transcribe-done", clipId, dossier });
      } catch (err) {
        if (controller.signal.aborted) return; // removed/cancelled mid-flight — not an error
        console.error(`[lab] cloud transcription failed for clip "${dossier.fileName}":`, err);
        if (filesRef.current.has(clipId)) {
          const message = err instanceof Error ? err.message : String(err);
          dispatch({ type: "cloud-transcribe-status", clipId, state: { status: "error", error: message } });
        }
      } finally {
        cloudAbortControllersRef.current.delete(clipId);
      }
    },
    [getOrchestrator],
  );

  /**
   * Drain the cloud-transcribe queue one item at a time. A non-forced item
   * (auto-queued) is left in place — NOT dropped — when cloudEnabled has
   * since turned off: the queue just pauses until re-enabled (toggling back
   * on, or any enqueue call, resumes it). A forced item (manual
   * cloudTranscribeClip) always proceeds regardless of the toggle.
   */
  const pumpCloudQueue = useCallback(() => {
    if (cloudProcessingRef.current) return;
    const next = cloudQueueRef.current[0];
    if (!next) return;
    if (!next.force && !transcriptionRef.current.cloudEnabled) return;

    cloudQueueRef.current.shift();
    cloudProcessingRef.current = true;
    void runCloudTranscribeItem(next.clipId).finally(() => {
      cloudProcessingRef.current = false;
      pumpCloudQueue();
    });
  }, [runCloudTranscribeItem]);

  /**
   * Add a clip to the cloud-transcribe queue (deduping by clipId — a clip
   * already waiting just gets promoted to `force` if this call requests it)
   * and immediately marks it "queued" so the UI reflects it before its turn
   * comes up.
   */
  const enqueueCloudTranscribe = useCallback(
    (clipId: string, opts: { force?: boolean } = {}) => {
      const force = opts.force ?? false;
      const existing = cloudQueueRef.current.find((item) => item.clipId === clipId);
      if (existing) {
        if (force) existing.force = true;
      } else {
        cloudQueueRef.current.push({ clipId, force });
        dispatch({ type: "cloud-transcribe-status", clipId, state: { status: "queued" } });
      }
      pumpCloudQueue();
    },
    [pumpCloudQueue],
  );

  /**
   * Auto-queue: whenever cloud transcription is enabled, every eligible done
   * clip (see shouldAutoQueueCloudTranscribe) gets enqueued. Re-running on
   * every state.clips change covers a clip finishing analysis while already
   * enabled; re-running when cloudEnabled flips on covers the backfill over
   * clips that finished earlier in the session. Also pumps unconditionally
   * so a toggle-back-on resumes items already sitting in the queue from
   * before it was turned off (see pumpCloudQueue).
   */
  useEffect(() => {
    if (!transcription.cloudEnabled) return;
    for (const c of state.clips) {
      if (shouldAutoQueueCloudTranscribe(c)) enqueueCloudTranscribe(c.clipId);
    }
    pumpCloudQueue();
  }, [state.clips, transcription.cloudEnabled, enqueueCloudTranscribe, pumpCloudQueue]);

  /**
   * Manually (re)run cloud transcription for one clip — retry affordance for
   * error rows, and a general re-run trigger regardless of the auto-queue
   * rules above (works even while cloudEnabled is off, on a clip that
   * already has a cloudTranscript, etc.). Re-running REPLACES the existing
   * cloudTranscript (see runCloudTranscribeItem). A clipId with no
   * File/dossier (already removed) is a harmless no-op once its turn comes.
   */
  const cloudTranscribeClip = useCallback(
    (clipId: string) => {
      enqueueCloudTranscribe(clipId, { force: true });
    },
    [enqueueCloudTranscribe],
  );

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
    cloudTranscribeClip,
  };
}
