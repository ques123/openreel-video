/**
 * The generate-flow state machine (contracts §"generate-flow state machine" +
 * docs/wizz-contracts.md §7). `applyEvent` is a PURE reducer over
 * `FlowState`/`FlowEvent` (below) — no side effects, no telemetry, no
 * gateway calls — so it is trivially unit tested and is the single source of
 * truth for "which scene is on screen".
 *
 * Three deliberate extensions beyond the literal `GenerateFlowState`/
 * `GenerateFlowEvent` union from @wizz/contracts, all documented where the
 * contract under-specifies a real transition:
 *
 * 1. `bench.allReady` is treated as advisory only: the reducer keeps it
 *    reasonably in sync (false on CLIPS_ADDED/CLIPS_CHANGED, true on
 *    ALL_CLIPS_READY) but scene components must read the LIVE
 *    `PublicPipeline.allReady` for actually gating the Generate button and
 *    its copy — the contract's CLIPS_CHANGED event carries no payload the
 *    reducer could recompute readiness from (an add vs. a remove-of-the-
 *    last-unready-clip have opposite effects on it), so a pure reducer
 *    cannot own that value precisely. use-generate-flow.ts edge-triggers
 *    ALL_CLIPS_READY off the live pipeline.
 * 2. `DIRECTOR_FAILED` with code `quota_exceeded` needs a `category` +
 *    `resetsAt` the event itself does not carry (GenerateFlowEvent's
 *    DIRECTOR_FAILED is `{type, code}` only). `applyEvent` takes an optional
 *    third `ctx` parameter — NOT part of the contract's event/state types —
 *    that supplies them; callers lacking that context (e.g. a bare unit
 *    test) get a same-shaped state with an empty category placeholder
 *    rather than a thrown error, and use-generate-flow.ts always supplies it
 *    from the caught GatewayError.
 * 3. `RESTORE_AVAILABLE`/`studio-restore-offer` need a `rememberedCount` —
 *    how much of the remembered footage's analysis cache is actually still
 *    current (see services/file-handles.ts's getStoredSessionInfo) — that
 *    the contract type has no field for at all. Unlike point 2, the
 *    dispatching call site always has the value already in hand, so rather
 *    than a side channel it's carried directly on an apps/web-local
 *    widening of just those two members: `FlowEvent`/`FlowState`. Every
 *    other member is untouched, so a plain contract-typed
 *    GenerateFlowState/GenerateFlowEvent value is still assignable wherever
 *    FlowState/FlowEvent is expected (telemetryForTransition below takes
 *    advantage of this and keeps the exact contract types).
 */
import type {
  GenerateFlowEvent,
  GenerateFlowState,
  QuotaCategory,
  TelemetryType,
} from "@wizz/contracts";

export interface ApplyEventCtx {
  /** Required to produce a well-formed quota-exceeded state (see file header, point 2). */
  quota?: { category: QuotaCategory; resetsAt: string };
}

/** See file header, point 3. */
export type FlowEvent =
  | Exclude<GenerateFlowEvent, { type: "RESTORE_AVAILABLE" }>
  | { type: "RESTORE_AVAILABLE"; clipCount: number; label: string; rememberedCount: number | null };

/** See file header, point 3. */
export type FlowState =
  | Exclude<GenerateFlowState, { name: "studio-restore-offer" }>
  | { name: "studio-restore-offer"; clipCount: number; label: string; rememberedCount: number | null };

export function applyEvent(
  state: FlowState,
  event: FlowEvent,
  ctx?: ApplyEventCtx,
): FlowState {
  // Global short-circuits: valid from (almost) any state.
  if (event.type === "UNSUPPORTED_BROWSER") return { name: "gate-unsupported" };
  if (event.type === "SESSION_MISSING") return { name: "needs-auth" };

  switch (event.type) {
    case "SESSION_OK":
      return { name: "studio-empty", firstVisit: true };

    case "RESTORE_AVAILABLE":
      if (state.name !== "studio-empty") return state;
      return {
        name: "studio-restore-offer",
        clipCount: event.clipCount,
        label: event.label,
        rememberedCount: event.rememberedCount,
      };

    case "RESTORE_ACCEPTED":
      if (state.name !== "studio-restore-offer") return state;
      return { name: "bench", allReady: false };

    case "RESTORE_DECLINED":
      if (state.name !== "studio-restore-offer") return state;
      return { name: "studio-empty", firstVisit: false };

    case "CLIPS_ADDED":
      // Reachable from studio-empty (first drop) or bench (+ add clips later).
      if (state.name !== "studio-empty" && state.name !== "bench") return state;
      return { name: "bench", allReady: false };

    case "ALL_CLIPS_READY":
      if (state.name !== "bench") return state;
      return { name: "bench", allReady: true };

    case "CLIPS_CHANGED":
      // Conservative: a changed set is presumed not-all-ready until the live
      // pipeline confirms otherwise (see file header, point 1).
      if (state.name !== "bench") return state;
      return { name: "bench", allReady: false };

    case "GENERATE":
      if (state.name !== "bench" || !state.allReady) return state;
      return { name: "directing", sinceRefine: false };

    case "DIRECTOR_DONE":
      if (state.name !== "directing") return state;
      return { name: "screening", rendering: false };

    case "DIRECTOR_CANCELLED":
      if (state.name !== "directing") return state;
      // Cancelling keeps the setup — the footage was already ready or the
      // user wouldn't have been able to press Generate.
      return { name: "bench", allReady: true };

    case "DIRECTOR_FAILED": {
      if (state.name !== "directing") return state;
      switch (event.code) {
        case "auth_required":
          return { name: "needs-auth" };
        case "quota_exceeded":
          return {
            name: "quota-exceeded",
            category: ctx?.quota?.category ?? "directorTokens",
            resetsAt: ctx?.quota?.resetsAt ?? new Date().toISOString(),
          };
        case "rate_limited":
          // Stay put; the directing scene shows an inline retry note driven
          // by the raw error, not a flow transition (contracts §7).
          return state;
        case "kill_switch":
          return { name: "service-away", reason: "kill_switch" };
        default:
          return { name: "service-away", reason: "upstream_error" };
      }
    }

    case "REFINE":
      if (state.name !== "screening") return state;
      return { name: "directing", sinceRefine: true };

    case "CHANGE_SETUP":
      // Reachable from screening, service-away, or quota-exceeded — always
      // back to a ready bench (footage was already analyzed).
      if (
        state.name !== "screening" &&
        state.name !== "service-away" &&
        state.name !== "quota-exceeded"
      ) {
        return state;
      }
      return { name: "bench", allReady: true };

    case "RENDER":
      if (state.name !== "screening") return state;
      return { name: "screening", rendering: true };

    case "RENDER_DONE":
      if (state.name !== "screening") return state;
      return { name: "screening", rendering: false };

    case "RENDER_CANCELLED":
      if (state.name !== "screening") return state;
      return { name: "screening", rendering: false };

    case "RETRY":
      if (state.name !== "service-away" && state.name !== "quota-exceeded") return state;
      return { name: "bench", allReady: true };

    default:
      return state;
  }
}

/** Fresh session's starting point, before boot-time checks resolve anything. */
export const INITIAL_FLOW_STATE: FlowState = { name: "needs-auth" };

/**
 * Fire-and-forget telemetry the flow emits on each transition (contracts §C:
 * "every transition also fires the matching telemetry"). Pure so it's
 * testable without a network; use-generate-flow.ts calls sendTelemetry for
 * each entry returned. Deliberately keyed on (prevState, event) rather than
 * nextState — several transitions are no-ops in applyEvent (guarded by a
 * mismatched prev state) and must not double-fire telemetry, which comparing
 * against the ALREADY-computed next state cannot distinguish from a real one
 * when prev === next by coincidence.
 */
export function telemetryForTransition(
  prev: GenerateFlowState,
  event: GenerateFlowEvent,
): { type: TelemetryType; data?: Record<string, string | number | boolean | null> }[] {
  switch (event.type) {
    case "SESSION_OK":
      return [{ type: "session_start" }];
    case "CLIPS_ADDED":
      if (prev.name !== "studio-empty" && prev.name !== "bench") return [];
      return [{ type: "analyze_started" }];
    case "ALL_CLIPS_READY":
      if (prev.name !== "bench") return [];
      return [{ type: "analyze_completed" }];
    case "GENERATE":
      if (prev.name !== "bench" || !prev.allReady) return [];
      return [{ type: "generate_started" }];
    case "DIRECTOR_DONE":
      if (prev.name !== "directing") return [];
      return [{ type: "generate_succeeded" }];
    case "DIRECTOR_FAILED":
      if (prev.name !== "directing") return [];
      // rate_limited doesn't leave the directing scene (inline retry), but
      // it's still a failed attempt worth counting.
      return [{ type: "generate_failed", data: { code: event.code, sinceRefine: prev.sinceRefine } }];
    case "REFINE":
      if (prev.name !== "screening") return [];
      return [{ type: "refine_started" }];
    case "RENDER":
      if (prev.name !== "screening") return [];
      return [{ type: "export_started" }];
    case "RENDER_DONE":
      if (prev.name !== "screening") return [];
      return [{ type: "export_completed" }];
    default:
      return [];
  }
}
