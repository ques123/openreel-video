/**
 * The director loop: drives an OpenAI-style tool-calling conversation until
 * the model submits a storyboard that survives validation.
 *
 * Pure orchestration — the model call (`complete`) and the local CLIP search
 * (`search`) are injected, so the loop is unit-testable with scripted fakes
 * and knows nothing about fetch, workers, or React.
 *
 * Invariant: every tool_call id in an assistant turn gets exactly one `tool`
 * reply message (OpenAI rejects the next completion otherwise — and models
 * do emit several search_shots calls in one turn).
 */

import type { SearchResult } from "./retrieval";
import type { ClipDossier } from "./types";
import {
  DIRECTOR_TOOLS,
  SEARCH_SHOTS_TOOL,
  SUBMIT_STORYBOARD_TOOL,
  type AssistantTurn,
  type ChatMessage,
  type DirectorActivity,
  type Storyboard,
  type ToolDef,
} from "./director-types";
import { formatSearchResults, formatValidationFeedback } from "./director-prompt";
import { validateStoryboard } from "./storyboard";

export type DirectorLoopErrorCode = "max-rounds" | "aborted" | "api" | "no-storyboard";

export class DirectorLoopError extends Error {
  constructor(
    public readonly code: DirectorLoopErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DirectorLoopError";
  }
}

export interface DirectorLoopDeps {
  complete(
    messages: ChatMessage[],
    tools: ToolDef[],
    toolChoice?: "auto" | { name: string },
  ): Promise<AssistantTurn>;
  /** Local CLIP retrieval (embed the query, score all shots). */
  search(query: string, topK: number): Promise<SearchResult>;
  dossiers: ClipDossier[];
  targetDurationS: number | null;
  /** Completion calls before giving up (default 10). */
  maxRounds?: number;
  onActivity?(activity: DirectorActivity): void;
  signal?: AbortSignal;
}

export interface DirectorLoopResult {
  storyboard: Storyboard;
  warnings: string[];
  /** Full conversation including the accepted submission — feed to refine. */
  messages: ChatMessage[];
}

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_SEARCH_TOP_K = 8;

export async function runDirectorLoop(
  initialMessages: ChatMessage[],
  deps: DirectorLoopDeps,
): Promise<DirectorLoopResult> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const emit = (a: DirectorActivity) => deps.onActivity?.(a);
  const messages: ChatMessage[] = [...initialMessages];

  for (let round = 1; round <= maxRounds; round += 1) {
    if (deps.signal?.aborted) throw new DirectorLoopError("aborted", "cancelled");
    emit({ kind: "round", round });

    const isLastRound = round === maxRounds;
    let turn: AssistantTurn;
    try {
      turn = await deps.complete(
        messages,
        DIRECTOR_TOOLS,
        isLastRound ? { name: SUBMIT_STORYBOARD_TOOL } : "auto",
      );
    } catch (err) {
      if (deps.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        throw new DirectorLoopError("aborted", "cancelled");
      }
      throw new DirectorLoopError("api", err instanceof Error ? err.message : String(err));
    }
    messages.push(turn);

    if (turn.content?.trim()) emit({ kind: "note", text: turn.content.trim() });

    const toolCalls = turn.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Prose-only turn: nudge it back onto the tools.
      messages.push({
        role: "user",
        content:
          "Use the tools: search_shots to check what the footage shows, then finish " +
          "with a single submit_storyboard call.",
      });
      continue;
    }

    let accepted: { storyboard: Storyboard; warnings: string[] } | null = null;

    for (const call of toolCalls) {
      const reply = (content: string) =>
        messages.push({ role: "tool", tool_call_id: call.id, content });

      if (call.function.name === SEARCH_SHOTS_TOOL) {
        let query = "";
        let topK = DEFAULT_SEARCH_TOP_K;
        try {
          const args = JSON.parse(call.function.arguments) as { query?: unknown; topK?: unknown };
          if (typeof args.query === "string") query = args.query.trim();
          if (typeof args.topK === "number") topK = Math.min(20, Math.max(1, Math.round(args.topK)));
        } catch {
          /* fall through to the empty-query error below */
        }
        if (!query) {
          reply('search_shots error: a non-empty "query" string is required.');
          continue;
        }
        try {
          const result = await deps.search(query, topK);
          emit({
            kind: "search",
            query,
            hitCount: result.hits.length,
            confidentCount: result.hits.filter((h) => h.confident).length,
            hits: result.hits.map((h) => ({
              clipId: h.clipId,
              shotIndex: h.shot.index,
              confident: h.confident,
            })),
          });
          reply(formatSearchResults(query, result));
        } catch (err) {
          reply(`search_shots error: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }

      if (call.function.name === SUBMIT_STORYBOARD_TOOL) {
        const validation = validateStoryboard(call.function.arguments, deps.dossiers, {
          targetDurationS: deps.targetDurationS,
        });
        if (validation.errors.length === 0 && validation.storyboard) {
          accepted = { storyboard: validation.storyboard, warnings: validation.warnings };
          reply("Storyboard accepted.");
        } else if (isLastRound && validation.storyboard) {
          // Out of rounds: keep the salvageable items rather than fail the run.
          accepted = {
            storyboard: validation.storyboard,
            warnings: [...validation.warnings, ...validation.errors],
          };
          reply("Storyboard accepted (with issues; out of rounds).");
        } else {
          emit({ kind: "rejected", errors: validation.errors });
          reply(formatValidationFeedback(validation.errors, validation.warnings));
        }
        continue;
      }

      reply(`unknown tool "${call.function.name}" — available: search_shots, submit_storyboard.`);
    }

    if (accepted) return { ...accepted, messages };
    if (isLastRound) {
      throw new DirectorLoopError(
        "no-storyboard",
        "the model could not produce a valid storyboard within the round limit",
      );
    }
  }

  // maxRounds < 1 is the only way here.
  throw new DirectorLoopError("max-rounds", "round limit reached before any submission");
}
