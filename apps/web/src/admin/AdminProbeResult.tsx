/**
 * Shared render for the Wave-2 section stubs' "one real gateway call" proof
 * of plumbing (see docs/wizz-video-plan.md §WS-C acceptance: "Section
 * components ... are Wave-2 stubs ... that ALSO make one real call via
 * gateway.ts"). Not a data-fetching hook — each section owns its own
 * useEffect/useState (module-level gateway.ts imports are stable across
 * renders, so no exhaustive-deps friction) — this is just the shared
 * three-state (loading/ok/error) presentational sliver so Users/Usage/
 * Presets/System don't each hand-roll the same JSX.
 */
import type { ReactNode } from "react";
import { GatewayError } from "../services/gateway";

export type ProbeState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: unknown };

/** GatewayError's message is explicitly safe to show verbatim in admin surfaces (see @wizz/contracts' WizzApiError doc comment). */
export function describeProbeError(error: unknown): string {
  if (error instanceof GatewayError) {
    return `${error.code} (HTTP ${error.status}): ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function AdminProbeResult<T>({
  state,
  render,
}: {
  state: ProbeState<T>;
  render: (data: T) => ReactNode;
}): ReactNode {
  if (state.status === "loading") {
    return <p className="text-sm text-text-secondary">Loading…</p>;
  }
  if (state.status === "error") {
    return <p className="font-mono text-sm text-status-error">{describeProbeError(state.error)}</p>;
  }
  return render(state.data);
}
