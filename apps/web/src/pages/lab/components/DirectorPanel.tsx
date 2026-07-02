import { useEffect, useRef, useState } from "react";
import type { DirectorActivity } from "@openreel/core";
import type { UseDirectorReturn } from "../use-director";

interface DirectorPanelProps {
  director: UseDirectorReturn;
  /** Same gate as search: CLIP model ready + at least one clip analyzed. */
  ready: boolean;
  clipsDone: number;
  clipsTotal: number;
}

function activityLine(a: DirectorActivity): string {
  switch (a.kind) {
    case "round":
      return `— round ${a.round} —`;
    case "search":
      return `searching: "${a.query}" → ${a.hitCount} hits (${a.confidentCount} confident)`;
    case "rejected":
      return `storyboard rejected: ${a.errors.length} issue${a.errors.length === 1 ? "" : "s"}, retrying`;
    case "note":
      return a.text;
  }
}

export function DirectorPanel({ director, ready, clipsDone, clipsTotal }: DirectorPanelProps) {
  const { state, start, refine, cancel, reset } = director;
  const [brief, setBrief] = useState("");
  const [target, setTarget] = useState("60");
  const [feedback, setFeedback] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.activity.length]);

  const running = state.phase === "running";
  const targetS = target.trim() === "" ? null : Math.max(5, Number(target) || 60);

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Director</h3>
      <p className="text-xs text-text-secondary mb-2">
        Describe the cut you want — an LLM reads the analysis (never the pixels) and
        drafts a storyboard.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (brief.trim() && !running) start(brief.trim(), targetS);
        }}
        className="space-y-2"
      >
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={ready ? 'e.g. "energetic highlight reel of the trip"' : "waiting for analyzed clips…"}
          disabled={!ready || running}
          rows={2}
          className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary/60 outline-none focus:border-primary resize-none"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-secondary flex items-center gap-1.5">
            target
            <input
              type="number"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              min={5}
              disabled={!ready || running}
              className="w-16 bg-background border border-border rounded-md px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
            />
            s
          </label>
          <div className="flex-1" />
          {running ? (
            <button
              type="button"
              onClick={cancel}
              className="px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              disabled={!ready || !brief.trim()}
              className="px-3 py-1.5 text-sm rounded-md bg-primary text-white disabled:opacity-40"
            >
              {state.storyboard ? "Start over" : "Direct"}
            </button>
          )}
        </div>
      </form>

      {running && clipsDone < clipsTotal && (
        <p className="text-[10px] text-text-secondary mt-1">
          using {state.clipCount} of {clipsTotal} clips ({clipsTotal - clipsDone} still analyzing)
        </p>
      )}

      {state.activity.length > 0 && (
        <div
          ref={logRef}
          className="mt-2 max-h-40 overflow-y-auto bg-background border border-border rounded-md p-2 space-y-0.5"
        >
          {state.activity.map((a, i) => (
            <p
              key={i}
              className={`text-[11px] font-mono leading-snug ${
                a.kind === "rejected"
                  ? "text-amber-500"
                  : a.kind === "note"
                    ? "text-text-secondary/70 italic truncate"
                    : "text-text-secondary"
              }`}
              title={a.kind === "note" ? a.text : undefined}
            >
              {activityLine(a)}
            </p>
          ))}
          {running && <p className="text-[11px] font-mono text-text-secondary animate-pulse">…</p>}
        </div>
      )}

      {state.phase === "error" && state.error && (
        <div className="mt-2 text-xs text-red-400 flex items-start gap-2">
          <p className="flex-1">{state.error}</p>
          <button onClick={reset} className="underline shrink-0">
            reset
          </button>
        </div>
      )}

      {state.phase === "awaiting-refine" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (feedback.trim()) {
              refine(feedback.trim());
              setFeedback("");
            }
          }}
          className="mt-2 flex gap-2"
        >
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder='refine: "less talking, more food close-ups"'
            className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary/60 outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={!feedback.trim()}
            className="px-3 py-1.5 text-sm rounded-md bg-primary text-white disabled:opacity-40"
          >
            Refine
          </button>
        </form>
      )}
    </div>
  );
}
