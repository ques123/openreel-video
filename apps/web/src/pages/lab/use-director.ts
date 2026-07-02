import { useCallback, useReducer, useRef } from "react";
import {
  DirectorLoopError,
  buildBriefMessage,
  buildDossierMessage,
  buildRefineMessage,
  buildSystemPrompt,
  runDirectorLoop,
  searchShots,
  type ChatMessage,
  type ClipDossier,
  type DirectorActivity,
  type Storyboard,
} from "@openreel/core";
import { DIRECTOR_MODEL, chatComplete } from "../../services/openai-proxy";

export type DirectorPhase = "idle" | "running" | "awaiting-refine" | "error";

export interface DirectorState {
  phase: DirectorPhase;
  targetDurationS: number | null;
  /** Live log of the current/last run (searches, notes, rejections). */
  activity: DirectorActivity[];
  storyboard: Storyboard | null;
  warnings: string[];
  error: string | null;
  /** Clips the current conversation is grounded on. */
  clipCount: number;
}

export interface UseDirectorDeps {
  getDossiers: () => ClipDossier[];
  embedQuery: (query: string) => Promise<Float32Array>;
}

const initialState: DirectorState = {
  phase: "idle",
  targetDurationS: null,
  activity: [],
  storyboard: null,
  warnings: [],
  error: null,
  clipCount: 0,
};

type Action =
  | { type: "run-start"; targetDurationS: number | null; clipCount: number }
  | { type: "activity"; activity: DirectorActivity }
  | { type: "success"; storyboard: Storyboard; warnings: string[] }
  | { type: "aborted" }
  | { type: "failure"; error: string }
  | { type: "remove-item"; index: number }
  | { type: "move-item"; from: number; to: number }
  | { type: "reset" };

function reducer(state: DirectorState, action: Action): DirectorState {
  switch (action.type) {
    case "run-start":
      return {
        ...state,
        phase: "running",
        targetDurationS: action.targetDurationS,
        clipCount: action.clipCount,
        activity: [],
        error: null,
      };
    case "activity":
      return { ...state, activity: [...state.activity, action.activity] };
    case "success":
      return {
        ...state,
        phase: "awaiting-refine",
        storyboard: action.storyboard,
        warnings: action.warnings,
      };
    case "aborted":
      return { ...state, phase: state.storyboard ? "awaiting-refine" : "idle" };
    case "failure":
      return { ...state, phase: "error", error: action.error };
    case "remove-item": {
      if (!state.storyboard) return state;
      const items = state.storyboard.items.filter((_, i) => i !== action.index);
      return { ...state, storyboard: { ...state.storyboard, items } };
    }
    case "move-item": {
      if (!state.storyboard) return state;
      const items = [...state.storyboard.items];
      const [moved] = items.splice(action.from, 1);
      items.splice(action.to, 0, moved);
      return { ...state, storyboard: { ...state.storyboard, items } };
    }
    case "reset":
      return { ...initialState };
    default:
      return state;
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof DirectorLoopError) {
    if (err.code === "no-storyboard") {
      return "The director couldn't produce a valid storyboard — try a simpler brief.";
    }
    if (err.code === "api") {
      if (err.message.includes("404") && err.message.includes("model")) {
        return `Model "${DIRECTOR_MODEL}" not available through the proxy (${err.message}).`;
      }
      if (err.message.includes("Failed to fetch") || err.message.includes("502")) {
        return "OpenAI proxy unreachable — is /api/proxy/openai configured (abacus nginx / vite proxy)?";
      }
      return err.message;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The director run: a tool-calling conversation with the LLM over the dossier
 * TEXT (never pixels), grounded by local CLIP search. History lives in a ref
 * so refine() continues the same conversation; the dossier snapshot is taken
 * at start() and reused for the whole conversation so the ground truth the
 * model has read doesn't shift between refinements.
 */
export function useDirector(deps: UseDirectorDeps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const messagesRef = useRef<ChatMessage[]>([]);
  const dossiersRef = useRef<ClipDossier[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const { getDossiers, embedQuery } = deps;

  const runLoop = useCallback(
    async (messages: ChatMessage[], targetDurationS: number | null) => {
      const dossiers = dossiersRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: "run-start", targetDurationS, clipCount: dossiers.length });
      try {
        const result = await runDirectorLoop(messages, {
          complete: (msgs, tools, toolChoice) =>
            chatComplete(
              {
                model: DIRECTOR_MODEL,
                messages: msgs,
                tools,
                tool_choice:
                  toolChoice && toolChoice !== "auto"
                    ? { type: "function", function: { name: toolChoice.name } }
                    : undefined,
              },
              controller.signal,
            ),
          search: async (query, topK) => searchShots(await embedQuery(query), dossiers, topK),
          dossiers,
          targetDurationS,
          onActivity: (activity) => dispatch({ type: "activity", activity }),
          signal: controller.signal,
        });
        messagesRef.current = result.messages;
        dispatch({ type: "success", storyboard: result.storyboard, warnings: result.warnings });
      } catch (err) {
        if (err instanceof DirectorLoopError && err.code === "aborted") {
          dispatch({ type: "aborted" });
        } else {
          dispatch({ type: "failure", error: friendlyError(err) });
        }
      } finally {
        abortRef.current = null;
      }
    },
    [embedQuery],
  );

  const start = useCallback(
    (brief: string, targetDurationS: number | null) => {
      const dossiers = getDossiers();
      if (dossiers.length === 0) {
        dispatch({ type: "failure", error: "No analyzed clips yet — drop footage first." });
        return;
      }
      dossiersRef.current = dossiers;
      const seed: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: buildDossierMessage(dossiers) + "\n\n" + buildBriefMessage(brief, targetDurationS),
        },
      ];
      messagesRef.current = seed;
      void runLoop(seed, targetDurationS);
    },
    [getDossiers, runLoop],
  );

  const refine = useCallback(
    // The target rides along so the user can retune duration between rounds
    // (feedback like "make it 12s" would otherwise fight the old target).
    (feedback: string, targetDurationS: number | null) => {
      if (state.phase !== "awaiting-refine" || !state.storyboard) return;
      // The refine message is committed to history only if the run succeeds
      // (runLoop stores result.messages) — a failed run doesn't pollute it.
      const messages: ChatMessage[] = [
        ...messagesRef.current,
        {
          role: "user",
          content: buildRefineMessage(feedback, state.storyboard, targetDurationS),
        },
      ];
      void runLoop(messages, targetDurationS);
    },
    [state.phase, state.storyboard, runLoop],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const removeItem = useCallback((index: number) => dispatch({ type: "remove-item", index }), []);
  const moveItem = useCallback(
    (from: number, to: number) => dispatch({ type: "move-item", from, to }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, start, refine, cancel, removeItem, moveItem, reset };
}

export type UseDirectorReturn = ReturnType<typeof useDirector>;
