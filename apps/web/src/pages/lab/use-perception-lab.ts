import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  FunnelOrchestrator,
  searchShots,
  templateQuery,
  type ClipDossier,
  type FunnelProgressEvent,
  type InferenceDevice,
  type SearchHit,
  type Shot,
  type TranscriptSegment,
} from "@openreel/core";

export type ClipStatus = "analyzing" | "done" | "error";

export interface LabClip {
  clipId: string;
  fileName: string;
  fileSize: number;
  status: ClipStatus;
  error?: string;
  durationS: number;
  /** Non-null when quota forced partial analysis (covers [0, this]). */
  analyzedThroughS: number | null;
  width: number;
  height: number;
  decodeT: number; // current decode position, seconds
  /** OPFS ingest progress 0..1, or null once decoding starts. */
  ingestProgress: number | null;
  shots: Shot[];
  embeddedCount: number;
  /** Dense caption pass progress (0/0 until the pass starts). */
  captionsDone: number;
  captionsTotal: number;
  transcript: TranscriptSegment[];
  dossier: ClipDossier | null;
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
  models: { clip: ModelStatus; whisper: ModelStatus; florence: ModelStatus };
  search: {
    query: string;
    hits: SearchHit[];
    searching: boolean;
  };
}

const initialModelStatus: ModelStatus = {
  state: "idle",
  device: null,
  loadMs: 0,
  files: {},
};

const initialState: LabState = {
  clips: [],
  models: {
    clip: { ...initialModelStatus },
    whisper: { ...initialModelStatus },
    florence: { ...initialModelStatus },
  },
  search: { query: "", hits: [], searching: false },
};

type Action =
  | { type: "clip-added"; clipId: string; fileName: string; fileSize: number }
  | { type: "event"; event: FunnelProgressEvent }
  | { type: "search-start"; query: string }
  | { type: "search-done"; query: string; hits: SearchHit[] }
  | { type: "search-clear" };

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

function reducer(state: LabState, action: Action): LabState {
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
            status: "analyzing",
            durationS: 0,
            analyzedThroughS: null,
            width: 0,
            height: 0,
            decodeT: 0,
            ingestProgress: null,
            shots: [],
            embeddedCount: 0,
            captionsDone: 0,
            captionsTotal: 0,
            transcript: [],
            dossier: null,
          },
        ],
      };

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
          }));
        case "clip-error":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            status: "error",
            error: e.message,
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

export function usePerceptionLab(forceDevice: "auto" | InferenceDevice = "auto") {
  const [state, dispatch] = useReducer(reducer, initialState);
  const orchestratorRef = useRef<FunnelOrchestrator | null>(null);
  const dossiersRef = useRef<Map<string, ClipDossier>>(new Map());
  /** clipId -> original File, for shot preview playback. */
  const filesRef = useRef<Map<string, File>>(new Map());

  const getOrchestrator = useCallback((): FunnelOrchestrator => {
    if (!orchestratorRef.current) {
      const orchestrator = new FunnelOrchestrator();
      orchestrator.onProgress((event) => {
        if (event.kind === "clip-done") {
          dossiersRef.current.set(event.clipId, event.dossier);
        }
        dispatch({ type: "event", event });
      });
      orchestratorRef.current = orchestrator;
    }
    return orchestratorRef.current;
  }, []);

  useEffect(() => {
    // Kick model downloads on mount so they overlap with the first decode.
    getOrchestrator().warmUp(forceDevice);
    return () => {
      orchestratorRef.current?.dispose();
      orchestratorRef.current = null;
    };
  }, [getOrchestrator, forceDevice]);

  const addFiles = useCallback(
    (files: File[]) => {
      const orchestrator = getOrchestrator();
      for (const file of files) {
        clipCounter += 1;
        const clipId = `lab-clip-${Date.now().toString(36)}-${clipCounter}`;
        filesRef.current.set(clipId, file);
        dispatch({ type: "clip-added", clipId, fileName: file.name, fileSize: file.size });
        orchestrator.analyzeFile(file, forceDevice, clipId).catch(() => {
          // clip-error event already updated the row; swallow the rejection.
        });
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
      } catch {
        dispatch({ type: "search-done", query: trimmed, hits: [] });
      }
    },
    [getOrchestrator, forceDevice],
  );

  const getFile = useCallback((clipId: string) => filesRef.current.get(clipId) ?? null, []);

  /** Snapshot of all completed dossiers (for the director). */
  const getDossiers = useCallback(() => [...dossiersRef.current.values()], []);

  /** Embed a text query with the local CLIP text tower (for the director's search tool). */
  const embedQuery = useCallback(
    (query: string) => getOrchestrator().embedText(templateQuery(query), forceDevice),
    [getOrchestrator, forceDevice],
  );

  return { state, addFiles, runSearch, getFile, getDossiers, embedQuery };
}
