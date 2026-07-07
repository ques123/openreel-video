/**
 * React Context wiring for use-generate-flow.ts's `useGenerateFlow()` — kept
 * in its own .tsx file so the hook itself stays JSX-free. Every scene
 * component reads the flow via `useFlow()` instead of prop-drilling.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useGenerateFlow, type Flow } from "./use-generate-flow";

const FlowContext = createContext<Flow | null>(null);

export function useFlow(): Flow {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error("useFlow() called outside <FlowProvider>");
  return ctx;
}

export function FlowProvider({ children }: { children: ReactNode }) {
  const flow = useGenerateFlow();
  return <FlowContext.Provider value={flow}>{children}</FlowContext.Provider>;
}
