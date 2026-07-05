import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  DEFAULT_PROMPT_SOURCES,
  DirectorLoopError,
  buildBriefMessage,
  buildDossierMessage,
  buildRefineMessage,
  buildSystemPrompt,
  runDirectorLoop,
  searchShots,
  type ChatMessage,
  type ClipDossier,
  type CloudRunMeta,
  type DirectorActivity,
  type PromptSources,
  type Storyboard,
} from "@openreel/core";
import {
  saveExperiment,
  type DirectorExperiment,
  type ExperimentCaptionStats,
} from "../../services/experiments";
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
  /**
   * The verbatim conversation with the LLM — everything that leaves the
   * machine, plus the model's replies and local tool results. Seeded at run
   * start, replaced with the full history when a run finishes.
   */
  messages: ChatMessage[];
  /** Source mixer used by the current conversation (locked at start). */
  promptSources: PromptSources;
  /** Persisted experiment id for the current conversation. */
  experimentId: string | null;
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
  messages: [],
  promptSources: DEFAULT_PROMPT_SOURCES,
  experimentId: null,
};

type Action =
  | {
      type: "run-start";
      targetDurationS: number | null;
      clipCount: number;
      messages: ChatMessage[];
      promptSources: PromptSources;
      experimentId: string;
    }
  | { type: "activity"; activity: DirectorActivity }
  | { type: "success"; storyboard: Storyboard; warnings: string[]; messages: ChatMessage[] }
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
        messages: action.messages,
        promptSources: action.promptSources,
        experimentId: action.experimentId,
      };
    case "activity":
      return { ...state, activity: [...state.activity, action.activity] };
    case "success":
      return {
        ...state,
        phase: "awaiting-refine",
        storyboard: action.storyboard,
        warnings: action.warnings,
        messages: action.messages,
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

/**
 * Resolve the CloudRunMeta a scope actually contributed to the prompt: a
 * pinned model looks up its archived (scope, model) run, falling back to the
 * clip's current run for that scope when this clip never ran the pin (same
 * fallback director-prompt.ts uses for the caption text itself, per the
 * PromptSources doc: "Clips lacking the pinned run fall back to their
 * latest, per clip.").
 */
function resolveCloudRun(
  dossier: ClipDossier,
  scope: "shots" | "timeline",
  pinnedModel: string | undefined,
): CloudRunMeta | null {
  if (pinnedModel) {
    return (
      dossier.cloudRunArchive.find((e) => e.scope === scope && e.model === pinnedModel)?.meta ??
      dossier.cloudRuns[scope]
    );
  }
  return dossier.cloudRuns[scope];
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
  /** The persisted record of the current conversation, updated as it grows. */
  const experimentRef = useRef<DirectorExperiment | null>(null);
  const activityLogRef = useRef<DirectorActivity[]>([]);
  const { getDossiers, embedQuery } = deps;

  const persistExperiment = useCallback(
    (patch: Partial<DirectorExperiment>) => {
      const exp = experimentRef.current;
      if (!exp) return;
      Object.assign(exp, patch, { updatedAt: Date.now() });
      void saveExperiment(exp).catch(() => undefined);
    },
    [],
  );

  const runLoop = useCallback(
    async (messages: ChatMessage[], targetDurationS: number | null) => {
      const dossiers = dossiersRef.current;
      const exp = experimentRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      const runStart = performance.now();
      dispatch({
        type: "run-start",
        targetDurationS,
        clipCount: dossiers.length,
        messages,
        promptSources: exp?.promptSources ?? DEFAULT_PROMPT_SOURCES,
        experimentId: exp?.id ?? "",
      });
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
              (usage) => {
                if (!exp) return;
                exp.usage.promptTokens += usage.promptTokens;
                exp.usage.completionTokens += usage.completionTokens;
                exp.usage.calls += 1;
              },
            ),
          search: async (query, topK) => searchShots(await embedQuery(query), dossiers, topK),
          dossiers,
          targetDurationS,
          onActivity: (activity) => {
            activityLogRef.current.push(activity);
            dispatch({ type: "activity", activity });
          },
          signal: controller.signal,
        });
        messagesRef.current = result.messages;
        dispatch({
          type: "success",
          storyboard: result.storyboard,
          warnings: result.warnings,
          messages: result.messages,
        });
        persistExperiment({
          targetDurationS,
          messages: result.messages,
          activity: [...activityLogRef.current],
          storyboard: result.storyboard,
          warnings: result.warnings,
          durationMs: (exp?.durationMs ?? 0) + Math.round(performance.now() - runStart),
        });
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
    [embedQuery, persistExperiment],
  );

  const start = useCallback(
    (
      brief: string,
      targetDurationS: number | null,
      sources?: PromptSources,
      briefAngle?: string,
    ) => {
      const dossiers = getDossiers();
      if (dossiers.length === 0) {
        dispatch({ type: "failure", error: "No analyzed clips yet — drop footage first." });
        return;
      }
      const promptSources = sources ?? DEFAULT_PROMPT_SOURCES;
      dossiersRef.current = dossiers;
      const seed: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content:
            buildDossierMessage(dossiers, promptSources) +
            "\n\n" +
            buildBriefMessage(brief, targetDurationS),
        },
      ];
      messagesRef.current = seed;
      activityLogRef.current = [];
      const captionModels =
        [
          ...new Set(
            dossiers.flatMap((d) => [
              promptSources.cloudTimeline
                ? resolveCloudRun(d, "timeline", promptSources.cloudTimelineModel)?.model
                : null,
              promptSources.cloudShots
                ? resolveCloudRun(d, "shots", promptSources.cloudShotsModel)?.model
                : null,
            ]),
          ),
        ]
          .filter((m): m is string => !!m)
          .join("+") || "local-only";
      // Aggregate cost/time over the SAME resolved runs that fed the prompt
      // (pin -> archive -> current-run fallback), so the number matches what
      // the director actually read, not just whatever ran most recently.
      const captionStats: ExperimentCaptionStats = {
        cloudFrames: 0,
        cloudPromptTokens: 0,
        cloudCompletionTokens: 0,
        cloudMs: 0,
        localFrames: 0,
        localMs: 0,
        byModel: {},
      };
      for (const d of dossiers) {
        for (const [scope, enabled, pin] of [
          ["shots", promptSources.cloudShots, promptSources.cloudShotsModel],
          ["timeline", promptSources.cloudTimeline, promptSources.cloudTimelineModel],
        ] as const) {
          if (!enabled) continue;
          const meta = resolveCloudRun(d, scope, pin);
          if (!meta) continue;
          captionStats.cloudFrames += meta.framesSent;
          captionStats.cloudPromptTokens += meta.promptTokens;
          captionStats.cloudCompletionTokens += meta.completionTokens;
          captionStats.cloudMs += meta.ms;
          const perModel = captionStats.byModel![meta.model] ?? {
            promptTokens: 0,
            completionTokens: 0,
          };
          perModel.promptTokens += meta.promptTokens;
          perModel.completionTokens += meta.completionTokens;
          captionStats.byModel![meta.model] = perModel;
        }
        if (promptSources.localCaptions && d.localCaptionPerf) {
          captionStats.localFrames += d.localCaptionPerf.frames;
          captionStats.localMs += d.localCaptionPerf.totalMs;
        }
      }
      experimentRef.current = {
        id: `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        at: Date.now(),
        updatedAt: Date.now(),
        brief,
        // Only set when a suggestion card seeded this brief — keeps old
        // records' shape unchanged (absent key, not an explicit undefined).
        ...(briefAngle ? { briefAngle } : {}),
        targetDurationS,
        promptSources,
        captionModels,
        model: DIRECTOR_MODEL,
        clips: dossiers.map((d) => ({
          clipId: d.clipId,
          cacheKey: d.cacheKey,
          fileName: d.fileName,
        })),
        messages: seed,
        activity: [],
        storyboard: null,
        warnings: [],
        usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
        durationMs: 0,
        captionStats,
      };
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

  // Manual storyboard edits (remove/reorder) update the persisted experiment,
  // so what you re-watch later is what you actually kept.
  useEffect(() => {
    if (state.phase === "awaiting-refine" && state.storyboard && experimentRef.current) {
      persistExperiment({ storyboard: state.storyboard });
    }
  }, [state.phase, state.storyboard, persistExperiment]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const removeItem = useCallback((index: number) => dispatch({ type: "remove-item", index }), []);
  const moveItem = useCallback(
    (from: number, to: number) => dispatch({ type: "move-item", from, to }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  /** The persisted record of the current conversation (for export/history). */
  const getExperiment = useCallback(() => experimentRef.current, []);

  return { state, start, refine, cancel, removeItem, moveItem, reset, getExperiment };
}

export type UseDirectorReturn = ReturnType<typeof useDirector>;
