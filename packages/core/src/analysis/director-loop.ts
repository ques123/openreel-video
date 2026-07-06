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
import {
  computeStoryboardMetrics,
  trimStoryboardToTarget,
  validateStoryboard,
  type StoryboardMetrics,
  type StoryboardValidation,
} from "./storyboard";

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
  /**
   * "direct" = fresh conversation, "refine" = continuing one that already
   * produced a storyboard. Sets the default round cap (refine re-sends the
   * whole — already long — conversation every round, so it gets fewer).
   * When omitted, inferred from the seed: any assistant turn means a
   * continued conversation, i.e. a refine.
   */
  mode?: "direct" | "refine";
  /** Completion calls before giving up (default DIRECT/REFINE_MAX_ROUNDS by mode). */
  maxRounds?: number;
  onActivity?(activity: DirectorActivity): void;
  signal?: AbortSignal;
}

/**
 * Machine-readable duration-target miss, for the UI to banner. Only the
 * out-of-rounds salvage can produce one — normal acceptance rejects >±10%
 * drift and makes the model retry.
 */
export interface DurationViolation {
  targetS: number;
  /** Total the model submitted. */
  submittedS: number;
  /** Total actually delivered, after any mechanical trim. */
  deliveredS: number;
  direction: "over" | "under";
  /** True when the loop dropped/shortened tail segments toward the target. */
  trimmed: boolean;
}

export interface DirectorLoopResult {
  storyboard: Storyboard;
  warnings: string[];
  /** Full conversation including the accepted submission — feed to refine. */
  messages: ChatMessage[];
  /** Non-null when the delivered cut missed the ±10% duration target. */
  durationViolation: DurationViolation | null;
  /** Zero-inference eval metrics of the delivered storyboard — log per run. */
  metrics: StoryboardMetrics;
}

/** Round cap for a fresh ("Direct") conversation. */
export const DIRECT_MAX_ROUNDS = 10;
/**
 * Lower cap for refine runs: every completion re-sends the WHOLE
 * conversation, and a refine already carries the full prior run — its tail
 * rounds are the most expensive calls the director makes.
 */
export const REFINE_MAX_ROUNDS = 6;
const DEFAULT_SEARCH_TOP_K = 8;

const fmtS = (s: number) => s.toFixed(1);

function parseSearchArgs(raw: string): { query: string; topK: number } {
  let query = "";
  let topK = DEFAULT_SEARCH_TOP_K;
  try {
    const args = JSON.parse(raw) as { query?: unknown; topK?: unknown };
    if (typeof args.query === "string") query = args.query.trim();
    if (typeof args.topK === "number") topK = Math.min(20, Math.max(1, Math.round(args.topK)));
  } catch {
    /* empty query -> the caller replies with the missing-query error */
  }
  return { query, topK };
}

/**
 * Out-of-rounds salvage: keep the usable items and demote validation errors
 * to warnings — but never silently ship a duration blowout. Over-target
 * boards are mechanically trimmed from the tail toward the target (narrative
 * order and the hook preserved), and every miss is surfaced both as a
 * machine-readable `durationViolation` and a leading DURATION warning.
 */
function salvageSubmission(
  storyboard: Storyboard,
  validation: StoryboardValidation,
  dossiers: ClipDossier[],
): Omit<DirectorLoopResult, "messages"> {
  let delivered = storyboard;
  const warnings = [...validation.warnings, ...validation.errors];
  let durationViolation: DurationViolation | null = null;
  const duration = validation.duration;
  if (duration?.violation === "over") {
    const trim = trimStoryboardToTarget(delivered, duration.targetS);
    delivered = trim.storyboard;
    const trimmed = trim.droppedItems > 0 || trim.shortenedLastByS > 0;
    durationViolation = {
      targetS: duration.targetS,
      submittedS: duration.totalS,
      deliveredS: trim.finalDurationS,
      direction: "over",
      trimmed,
    };
    warnings.unshift(
      `DURATION: submitted ${fmtS(duration.totalS)}s vs ${fmtS(duration.targetS)}s target — ` +
        (trimmed
          ? `mechanically trimmed to ${fmtS(trim.finalDurationS)}s (dropped ` +
            `${trim.droppedItems} tail segment${trim.droppedItems === 1 ? "" : "s"}` +
            (trim.shortenedLastByS > 0
              ? `, shortened the last by ${fmtS(trim.shortenedLastByS)}s`
              : "") +
            `)`
          : `could not trim further`),
    );
  } else if (duration?.violation === "under") {
    durationViolation = {
      targetS: duration.targetS,
      submittedS: duration.totalS,
      deliveredS: duration.totalS,
      direction: "under",
      trimmed: false,
    };
    warnings.unshift(
      `DURATION: delivered ${fmtS(duration.totalS)}s vs ${fmtS(duration.targetS)}s target ` +
        `(under — nothing to trim; consider a refine or a shorter target)`,
    );
  }
  return {
    storyboard: delivered,
    warnings,
    durationViolation,
    // Recompute on what we actually deliver — a trim moves/removes cuts.
    metrics: computeStoryboardMetrics(delivered, dossiers),
  };
}

export async function runDirectorLoop(
  initialMessages: ChatMessage[],
  deps: DirectorLoopDeps,
): Promise<DirectorLoopResult> {
  const mode =
    deps.mode ?? (initialMessages.some((m) => m.role === "assistant") ? "refine" : "direct");
  const maxRounds =
    deps.maxRounds ?? (mode === "refine" ? REFINE_MAX_ROUNDS : DIRECT_MAX_ROUNDS);
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

    let accepted: Omit<DirectorLoopResult, "messages"> | null = null;

    // Start every search in the turn concurrently (models often emit several
    // search_shots calls at once) — a multi-search round costs one search's
    // latency instead of the sum. Replies still go out in call order below,
    // and each promise carries its own error capture, so the per-call
    // reply/error semantics are unchanged.
    const pendingSearches = new Map<
      string,
      {
        query: string;
        outcome: Promise<{ ok: true; result: SearchResult } | { ok: false; error: string }>;
      }
    >();
    for (const call of toolCalls) {
      if (call.function.name !== SEARCH_SHOTS_TOOL) continue;
      const { query, topK } = parseSearchArgs(call.function.arguments);
      if (!query) continue;
      pendingSearches.set(call.id, {
        query,
        outcome: deps.search(query, topK).then(
          (result) => ({ ok: true as const, result }),
          (err) => ({
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      });
    }

    for (const call of toolCalls) {
      const reply = (content: string) =>
        messages.push({ role: "tool", tool_call_id: call.id, content });

      if (call.function.name === SEARCH_SHOTS_TOOL) {
        const pending = pendingSearches.get(call.id);
        if (!pending) {
          reply('search_shots error: a non-empty "query" string is required.');
          continue;
        }
        const outcome = await pending.outcome;
        if (outcome.ok) {
          const { result } = outcome;
          emit({
            kind: "search",
            query: pending.query,
            hitCount: result.hits.length,
            confidentCount: result.hits.filter((h) => h.confident).length,
            hits: result.hits.map((h) => ({
              clipId: h.clipId,
              shotIndex: h.shot.index,
              confident: h.confident,
            })),
          });
          reply(formatSearchResults(pending.query, result));
        } else {
          reply(`search_shots error: ${outcome.error}`);
        }
        continue;
      }

      if (call.function.name === SUBMIT_STORYBOARD_TOOL) {
        const validation = validateStoryboard(call.function.arguments, deps.dossiers, {
          targetDurationS: deps.targetDurationS,
        });
        if (validation.errors.length === 0 && validation.storyboard) {
          accepted = {
            storyboard: validation.storyboard,
            warnings: validation.warnings,
            durationViolation: null,
            metrics:
              validation.metrics ??
              computeStoryboardMetrics(validation.storyboard, deps.dossiers),
          };
          reply("Storyboard accepted.");
        } else if (isLastRound && validation.storyboard) {
          // Out of rounds: keep the salvageable items rather than fail the run.
          accepted = salvageSubmission(validation.storyboard, validation, deps.dossiers);
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
