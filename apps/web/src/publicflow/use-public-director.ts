/**
 * The public director: drives packages/core's runDirectorLoop exactly as the
 * admin lab's use-director.ts does (candidates-mode selection, the same
 * system/brief/candidates prompt builders, refine continuing the same
 * conversation) — but reduced to the public vocabulary and with NONE of the
 * lab's experiment/IndexedDB plumbing: no saveExperiment, no experiment
 * snapshotting, nothing persisted beyond this session's React state.
 *
 * Deliberately NOT wrapping pages/lab/use-director.ts: that hook calls
 * services/experiments.ts's saveExperiment unconditionally inside its run
 * loop (exactly the IndexedDB writes this item must NOT perform), and its
 * chatComplete transport (services/openai-proxy.ts) throws a plain Error
 * with no structured WizzErrorCode — unusable for contracts §7's error-phase
 * mapping. See internal/gateway-chat.ts for the transport this file uses
 * instead, and internal/gateway-error-mapping.ts for the mapping itself.
 *
 * Music (when request.music) reuses services/suno.ts's existing generator
 * unmodified — it already falls back to a pure heuristic on ANY failure, so
 * music generation can never surface an error here, only silently stay
 * absent (PublicCut.musicTakes null). The cut itself is shown the moment the
 * storyboard is accepted; music lands afterward via a phase update in place
 * (see the "music-ready" reducer action) rather than blocking the reveal for
 * Suno's ~60s generation time.
 *
 * cancel() ALWAYS resolves to `{kind:"idle"}`, never back to a previous
 * "done" cut — this matches publicapp/state-machine.ts's DIRECTOR_CANCELLED
 * transition (always -> bench) and publicapp/mocks.ts's useMockDirector,
 * both already built against this behavior: once a generate/refine run
 * starts, the flow can only leave "directing" via DONE, a mapped FAILED, or
 * CANCELLED-back-to-bench — never back to "screening" — so retaining the
 * previous cut in `phase` after a cancel/error has no reachable UI anyway.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  buildBriefMessage,
  buildCandidatesMessage,
  buildDossierMessage,
  buildRefineMessage,
  buildSystemPrompt,
  DEFAULT_PROMPT_SOURCES,
  DEFAULT_SELECTOR_CONFIG,
  DirectorLoopError,
  runDirectorLoop,
  searchShots,
  selectCandidates,
  selectorConfigForPreset,
  stylePresetById,
  type ChatMessage,
  type ClipDossier,
  type PromptSources,
  type Storyboard,
} from "@openreel/core";
import { DEFAULT_PUBLISHED_PRESET } from "@wizz/contracts";
import {
  generateMusicBrief,
  pollMusicTask,
  proxiedMusicUrl,
  startMusicGeneration,
} from "../services/suno";
import { assemblePublicCut, hasStoryboardTitle } from "./internal/cut-assembly";
import { buildFilmTitleFallback } from "./internal/film-title";
import { completeViaGateway } from "./internal/gateway-chat";
import { mapDirectorError } from "./internal/gateway-error-mapping";
import { ASSEMBLING_LINE, reduceDirectorActivity, type NarrativeLine } from "./internal/narrative";
import { labSettingsOf } from "./preset-runtime";
import type { PublicPipelineHandle } from "./use-public-pipeline";
import type { CutRequest, DirectorPhase, PublicCut, PublicDirector, PublicRunConfig } from "./types";

/** Cheap, fast model for the one-shot title aux call — deliberately NOT the (possibly pricier) director model. */
const TITLE_MODEL = "gpt-5.4-mini";
const MUSIC_POLL_INTERVAL_MS = 10_000;
const MUSIC_TIMEOUT_MS = 10 * 60 * 1000;

type Action =
  | { type: "run-start" }
  | { type: "activity"; line: NarrativeLine }
  | { type: "done"; cut: PublicCut }
  | { type: "music-ready"; musicTakes: { a: string; b: string } }
  | { type: "error"; error: { code: string; friendly: string; retryable: boolean } }
  | { type: "idle" };

function reducer(phase: DirectorPhase, action: Action): DirectorPhase {
  switch (action.type) {
    case "run-start":
      return { kind: "running", activity: [] };
    case "activity":
      return phase.kind === "running"
        ? { kind: "running", activity: [...phase.activity, action.line] }
        : phase;
    case "done":
      return { kind: "done", cut: action.cut };
    case "music-ready":
      // Updates the cut IN PLACE once Suno lands — never re-enters "running".
      return phase.kind === "done" ? { kind: "done", cut: { ...phase.cut, musicTakes: action.musicTakes } } : phase;
    case "error":
      return { kind: "error", ...action.error };
    case "idle":
      return { kind: "idle" };
    default:
      return phase;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Suno path, unmodified generator + polling until 2 takes land (or one
 * "ready" track, degenerately mirrored as both a/b), a failure, or a
 * timeout. Every outcome besides success is a silent no-op — music is a
 * bonus that must never surface an error or block the cut (see the file
 * header and services/suno.ts's own generateMusicBrief resilience stance).
 */
async function runMusic(
  storyboard: Storyboard,
  request: CutRequest,
  targetDurationS: number | null,
  signal: AbortSignal,
  onReady: (takes: { a: string; b: string }) => void,
): Promise<void> {
  try {
    const sceneHints = storyboard.items
      .slice(0, 5)
      .map((item) => item.why)
      .filter((why): why is string => Boolean(why));
    const styleHint = stylePresetById(request.styleId)?.musicHint ?? null;
    const brief = await generateMusicBrief(request.brief, storyboard, targetDurationS, sceneHints, styleHint);
    if (signal.aborted) return;
    const taskId = await startMusicGeneration(brief);

    const startedAtMs = Date.now();
    while (!signal.aborted && Date.now() - startedAtMs < MUSIC_TIMEOUT_MS) {
      const result = await pollMusicTask(taskId);
      if (signal.aborted) return;
      if (result.status === "failed") return;
      if (result.tracks.length >= 2) {
        onReady({ a: proxiedMusicUrl(result.tracks[0].audioUrl), b: proxiedMusicUrl(result.tracks[1].audioUrl) });
        return;
      }
      if (result.status === "ready" && result.tracks.length === 1) {
        onReady({ a: proxiedMusicUrl(result.tracks[0].audioUrl), b: proxiedMusicUrl(result.tracks[0].audioUrl) });
        return;
      }
      await delay(MUSIC_POLL_INTERVAL_MS, signal);
    }
  } catch {
    // Silent give-up — see file header.
  }
}

/**
 * Title resolution: the storyboard/notes title when the IR carries one,
 * else one cheap aux call, else film-title.ts's pure fallback. Never throws.
 */
async function resolveCutTitle(storyboard: Storyboard, request: CutRequest): Promise<string> {
  if (hasStoryboardTitle(storyboard)) return storyboard.title!.trim();
  const styleLabel = stylePresetById(request.styleId)?.label ?? null;
  try {
    const turn = await completeViaGateway(
      {
        model: TITLE_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You write a short, evocative title (at most 6 words) for a home-video edit, given the " +
              "editor's brief and shot roles. Reply with ONLY the title itself — no quotes, no surrounding punctuation.",
          },
          {
            role: "user",
            content: [
              `Brief: ${request.brief.trim() || "(none given)"}`,
              storyboard.notes ? `Editor notes: ${storyboard.notes}` : null,
              storyboard.items.length > 0
                ? `Shot roles in order: ${storyboard.items.map((item) => item.role).join(", ")}`
                : null,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
          },
        ],
      },
      undefined,
      undefined,
    );
    const text = turn.content?.trim().replace(/^["'“]+|["'”]+$/g, "");
    if (text) return text.slice(0, 80);
    throw new Error("empty title response");
  } catch {
    return buildFilmTitleFallback(request.brief, styleLabel);
  }
}

/** The source mixer + selector config for a run, derived from the preset (+ the chosen style's soft-focus adjustment). */
function runtimeFor(config: PublicRunConfig | null, request: CutRequest) {
  const stylePreset = stylePresetById(request.styleId);
  const promptMode = config?.preset.promptMode ?? "candidates";
  const transcriptSource = config?.preset.transcriptSource ?? "local";
  const cloudCaptionsOn = config?.preset.cloudCaptionsEnabled ?? false;
  const sources: PromptSources = {
    ...DEFAULT_PROMPT_SOURCES,
    cloudShots: cloudCaptionsOn,
    cloudTimeline: cloudCaptionsOn,
    promptMode,
    transcriptSource,
  };
  const baseSelector = config ? labSettingsOf(config).selector : DEFAULT_SELECTOR_CONFIG;
  const selectorConfig = selectorConfigForPreset(stylePreset, baseSelector);
  const model = config?.preset.directorModel ?? DEFAULT_PUBLISHED_PRESET.directorModel;
  return { stylePreset, promptMode, sources, selectorConfig, model };
}

export function usePublicDirector(
  config: PublicRunConfig | null,
  pipeline: PublicPipelineHandle | null | undefined,
): PublicDirector {
  const [phase, dispatch] = useReducer(reducer, { kind: "idle" } as DirectorPhase);
  const messagesRef = useRef<ChatMessage[]>([]);
  const dossiersRef = useRef<ClipDossier[]>([]);
  const storyboardRef = useRef<Storyboard | null>(null);
  const requestRef = useRef<CutRequest | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const musicAbortRef = useRef<AbortController | null>(null);
  const modelRef = useRef<string>(DEFAULT_PUBLISHED_PRESET.directorModel);
  const pipelineRef = useRef(pipeline);
  pipelineRef.current = pipeline;

  useEffect(
    () => () => {
      abortRef.current?.abort();
      musicAbortRef.current?.abort();
    },
    [],
  );

  const runLoop = useCallback(
    (messages: ChatMessage[], targetDurationS: number | null, isRefine: boolean, request: CutRequest) => {
      musicAbortRef.current?.abort(); // a fresh run supersedes any music still generating for the PREVIOUS cut
      const controller = new AbortController();
      abortRef.current = controller;
      const model = modelRef.current;
      dispatch({ type: "run-start" });

      void (async () => {
        try {
          const result = await runDirectorLoop(messages, {
            mode: isRefine ? "refine" : "direct",
            complete: (msgs, tools, toolChoice) =>
              completeViaGateway(
                {
                  model,
                  messages: msgs,
                  tools,
                  tool_choice:
                    toolChoice && toolChoice !== "auto"
                      ? { type: "function", function: { name: toolChoice.name } }
                      : undefined,
                },
                controller.signal,
                undefined,
              ),
            search: async (query, topK) => {
              const currentPipeline = pipelineRef.current;
              if (!currentPipeline) return { hits: [], mean: 0, std: 0 };
              const embedding = await currentPipeline.embedQuery(query);
              return searchShots(embedding, dossiersRef.current, topK);
            },
            dossiers: dossiersRef.current,
            targetDurationS,
            onActivity: (activity) => {
              const line = reduceDirectorActivity(activity, isRefine);
              if (line) dispatch({ type: "activity", line });
            },
            signal: controller.signal,
          });

          messagesRef.current = result.messages;
          storyboardRef.current = result.storyboard;
          dispatch({ type: "activity", line: ASSEMBLING_LINE });

          const title = await resolveCutTitle(result.storyboard, request);
          dispatch({ type: "done", cut: assemblePublicCut(result.storyboard, title, null) });

          if (request.music) {
            const musicController = new AbortController();
            musicAbortRef.current = musicController;
            void runMusic(result.storyboard, request, targetDurationS, musicController.signal, (takes) => {
              dispatch({ type: "music-ready", musicTakes: takes });
            });
          }
        } catch (err) {
          if (err instanceof DirectorLoopError && err.code === "aborted") {
            dispatch({ type: "idle" });
          } else {
            dispatch({ type: "error", error: mapDirectorError(err) });
          }
        } finally {
          abortRef.current = null;
        }
      })();
    },
    [],
  );

  const generate = useCallback(
    (request: CutRequest) => {
      const dossiers = pipelineRef.current?.getDossiers() ?? [];
      if (dossiers.length === 0) {
        dispatch({
          type: "error",
          error: { code: "no_footage", friendly: "No analyzed clips yet — drop footage first.", retryable: true },
        });
        return;
      }
      dossiersRef.current = dossiers;
      requestRef.current = request;
      const { stylePreset, promptMode, sources, selectorConfig, model } = runtimeFor(config, request);
      modelRef.current = model;

      let footageMessage: string;
      if (promptMode === "candidates") {
        const selection = selectCandidates(dossiers, selectorConfig);
        footageMessage = buildCandidatesMessage(dossiers, selection, sources);
      } else {
        footageMessage = buildDossierMessage(dossiers, sources);
      }

      const brief = stylePreset
        ? `${request.brief}\n\nHow it should feel (style — ${stylePreset.label}): ${stylePreset.directorNote}`
        : request.brief;
      const seed: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: `${footageMessage}\n\n${buildBriefMessage(brief, request.targetS)}` },
      ];
      messagesRef.current = seed;
      runLoop(seed, request.targetS, false, request);
    },
    [config, runLoop],
  );

  const refine = useCallback(
    (instruction: string) => {
      // Only reachable once a cut exists — mirrors publicapp's flow state
      // machine (REFINE is only valid from the "screening" scene).
      if (!storyboardRef.current || !requestRef.current) return;
      const request = requestRef.current;
      const messages: ChatMessage[] = [
        ...messagesRef.current,
        { role: "user", content: buildRefineMessage(instruction, storyboardRef.current, request.targetS) },
      ];
      runLoop(messages, request.targetS, true, request);
    },
    [runLoop],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    musicAbortRef.current?.abort();
    messagesRef.current = [];
    dossiersRef.current = [];
    storyboardRef.current = null;
    requestRef.current = null;
    dispatch({ type: "idle" });
  }, []);

  return useMemo<PublicDirector>(
    () => ({ phase, generate, refine, cancel, reset }),
    [phase, generate, refine, cancel, reset],
  );
}
