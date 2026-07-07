/**
 * /app/editor — the "Open in editor" handoff's destination. Dynamic-imports
 * the existing editor tree (spec F: "keep the generate flow light" — the
 * editor chunk must stay a separate lazy chunk, never in the entry JS) and
 * mounts it exactly as App.tsx does for the main app (TooltipProvider +
 * full-screen shell; Tailwind utilities work here because main.tsx imports
 * index.css unconditionally regardless of build target). By the time this
 * route renders, use-generate-flow.ts's openEditor() has already compiled
 * the cut into the project store via services/compile-storyboard.ts — this
 * component only needs to display it. One-way: nothing here reads flow
 * state back out.
 */
import { lazy, Suspense } from "react";
import { TooltipProvider } from "@openreel/ui";

const EditorInterface = lazy(() =>
  import("../../components/editor/EditorInterface").then((m) => ({ default: m.EditorInterface })),
);

function EditorLoadingSpinner() {
  return (
    <div className="h-screen w-screen bg-background flex flex-col items-center justify-center">
      <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
      <p className="text-sm text-text-secondary">Loading editor…</p>
    </div>
  );
}

export function EditorRoute() {
  return (
    <TooltipProvider>
      <div className="h-screen w-screen bg-background text-text-primary overflow-hidden">
        <Suspense fallback={<EditorLoadingSpinner />}>
          <EditorInterface />
        </Suspense>
      </div>
    </TooltipProvider>
  );
}
