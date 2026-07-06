import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PROMPT_SOURCES,
  STYLE_PRESETS,
  stylePresetById,
  type DirectorActivity,
  type PromptSources,
} from "@openreel/core";
import type { BriefSuggestion } from "../../../services/brief-suggestions";
import type { UseDirectorReturn } from "../use-director";
import type { MusicState } from "../use-music";
import { PromptInspectorModal } from "./PromptInspectorModal";

interface DirectorPanelProps {
  director: UseDirectorReturn;
  /** Same gate as search: CLIP model ready + at least one clip analyzed. */
  ready: boolean;
  clipsDone: number;
  clipsTotal: number;
  /** Archived caption models available across loaded clips, per scope. */
  captionModelOptions: { shots: string[]; timeline: string[] };
  /** Contextual background-music toggle — owned by the page so it survives Direct/refine cycles. */
  musicEnabled: boolean;
  onMusicEnabledChange: (checked: boolean) => void;
  musicState: MusicState;
  onMusicRetry: () => void;
  /** Digest-grounded editorial angle cards for the brief textarea; takes the parsed target so the page can mention it. */
  requestBriefSuggestions: (targetS: number | null) => Promise<BriefSuggestion[]>;
  /** Locked style preset id (or null = unlocked) — lifted to the page so director + music can share it. */
  styleId: string | null;
  onStyleIdChange: (id: string | null) => void;
}

/** "Xs" elapsed since a music generation started, ticking once a second while it's in flight. */
function useElapsedS(startedAtMs: number | null, live: boolean): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  return startedAtMs ? Math.round((Date.now() - startedAtMs) / 1000) : 0;
}

function musicStatusLine(music: MusicState, elapsedS: number): string {
  if (music.phase === "ready") {
    return `♪ ${music.tracks.length} track${music.tracks.length === 1 ? "" : "s"} ready`;
  }
  if (music.tracks.length > 0) {
    return `♪ ${music.tracks.length} track${music.tracks.length === 1 ? "" : "s"} ready, more incoming…(${elapsedS}s)`;
  }
  return `♪ generating…(${elapsedS}s)`;
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

export function DirectorPanel({
  director,
  ready,
  clipsDone,
  clipsTotal,
  captionModelOptions,
  musicEnabled,
  onMusicEnabledChange,
  musicState,
  onMusicRetry,
  requestBriefSuggestions,
  styleId,
  onStyleIdChange,
}: DirectorPanelProps) {
  const { state, start, refine, cancel, reset } = director;
  const [brief, setBrief] = useState("");
  const [target, setTarget] = useState("60");
  const [sources, setSources] = useState<PromptSources>(DEFAULT_PROMPT_SOURCES);
  const [feedback, setFeedback] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<BriefSuggestion[]>([]);
  const [suggestionsVisible, setSuggestionsVisible] = useState(true);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null);
  // Generation counter, not a boolean flag: a second "new angles" click while
  // one is in flight must make the FIRST call's eventual result a no-op
  // rather than racing it (same idea as use-music's cancelledRef, simplified
  // since there's no polling to tear down here).
  const suggestGenRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      suggestGenRef.current += 1; // invalidate any in-flight request on unmount
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.activity.length]);

  const running = state.phase === "running";
  const targetS = target.trim() === "" ? null : Math.max(5, Number(target) || 60);
  const musicElapsedS = useElapsedS(
    musicState.startedAtMs,
    musicState.phase === "generating" || musicState.phase === "partial",
  );

  const requestSuggestions = () => {
    if (!ready || running || suggestLoading) return;
    const gen = ++suggestGenRef.current;
    setSuggestLoading(true);
    setSuggestError(null);
    requestBriefSuggestions(targetS)
      .then((result) => {
        if (suggestGenRef.current !== gen) return; // a newer request (or unmount) won
        setSuggestions(result);
        setSuggestionsVisible(true);
      })
      .catch((err) => {
        if (suggestGenRef.current !== gen) return;
        setSuggestError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (suggestGenRef.current !== gen) return;
        setSuggestLoading(false);
      });
  };

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold text-text-primary">Director</h3>
        {state.messages.length > 0 && (
          <button
            onClick={() => setInspectorOpen(true)}
            className="text-[10px] text-text-secondary hover:text-text-primary underline decoration-dotted"
            title="Inspect the exact text sent to the model"
          >
            what was sent to the AI →
          </button>
        )}
      </div>
      <p className="text-xs text-text-secondary mb-2">
        Describe the cut you want — an LLM reads the analysis (never the pixels) and
        drafts a storyboard.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (brief.trim() && !running)
            start(brief.trim(), targetS, sources, appliedLabel ?? undefined, styleId ?? undefined);
        }}
        className="space-y-2"
      >
        <textarea
          value={brief}
          onChange={(e) => {
            const v = e.target.value;
            setBrief(v);
            // Clearing the textarea drops the angle seed; editing it in place
            // keeps the label — the point of the label is to name the angle,
            // and edits are the expected next step, not a break from it.
            if (v === "") setAppliedLabel(null);
          }}
          placeholder={ready ? 'e.g. "energetic highlight reel of the trip"' : "waiting for analyzed clips…"}
          disabled={!ready || running}
          rows={2}
          className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary/60 outline-none focus:border-primary resize-none"
        />

        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-text-secondary">style:</span>
          <div className="flex flex-wrap gap-1">
            {STYLE_PRESETS.map((preset) => {
              const selected = styleId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.tagline}
                  disabled={running}
                  onClick={() => onStyleIdChange(selected ? null : preset.id)}
                  className={`px-1.5 py-0.5 text-[11px] rounded-md border disabled:opacity-40 ${
                    selected
                      ? "border-primary bg-primary/10 text-text-primary"
                      : "border-border text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={requestSuggestions}
            disabled={!ready || running || suggestLoading}
            className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            {suggestLoading ? "suggesting…" : suggestions.length > 0 ? "↻ new angles" : "✨ suggest briefs"}
          </button>
          {suggestError && <p className="flex-1 text-amber-500 text-[11px]">{suggestError}</p>}
          {suggestions.length > 0 && suggestionsVisible && !suggestError && (
            <button
              type="button"
              onClick={() => setSuggestionsVisible(false)}
              className="ml-auto text-[11px] text-text-secondary hover:text-text-primary"
            >
              hide
            </button>
          )}
        </div>

        {suggestions.length > 0 && suggestionsVisible && (
          <div className="grid grid-cols-2 gap-1.5">
            {suggestions.map((s, i) => {
              const applied = appliedLabel === s.label;
              const stylePreset = s.styleId ? stylePresetById(s.styleId) : null;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setBrief(s.brief);
                    setAppliedLabel(s.label);
                    if (s.styleId) onStyleIdChange(s.styleId);
                  }}
                  title={s.brief}
                  className={`text-left bg-background border rounded-md px-2 py-1.5 hover:border-primary/60 transition-colors ${
                    applied ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <p className="text-[11px] font-medium text-text-primary">{s.label}</p>
                  {stylePreset && stylePreset.id !== styleId && (
                    <p className="text-[10px] text-text-secondary/80">{stylePreset.label}</p>
                  )}
                  <p className="text-[11px] text-text-secondary line-clamp-3">{s.brief}</p>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
          <span className="font-medium" title="Which perception sources the director gets — for A/B testing input combinations">
            send:
          </span>
          {(
            [
              ["localCaptions", "local captions", null],
              ["cloudShots", "cloud shots", "cloudShotsModel"],
              ["cloudTimeline", "cloud timeline", "cloudTimelineModel"],
              ["transcript", "transcript", null],
            ] as [keyof PromptSources & string, string, "cloudShotsModel" | "cloudTimelineModel" | null][]
          ).map(([key, label, pinKey]) => {
            const options =
              pinKey === "cloudShotsModel"
                ? captionModelOptions.shots
                : pinKey === "cloudTimelineModel"
                  ? captionModelOptions.timeline
                  : [];
            return (
              <span key={key} className="flex items-center gap-1">
                <label className="flex items-center gap-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sources[key] as boolean}
                    disabled={!ready || running}
                    onChange={(e) => setSources((s) => ({ ...s, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
                {pinKey && sources[key] && options.length > 1 && (
                  <select
                    className="bg-background border border-border rounded px-1 py-0 text-[10px] text-text-primary"
                    value={sources[pinKey] ?? ""}
                    disabled={!ready || running}
                    onChange={(e) =>
                      setSources((s) => ({ ...s, [pinKey]: e.target.value || undefined }))
                    }
                    title="Which archived caption run the director reads (latest = most recent enhance per clip)"
                  >
                    <option value="">latest</option>
                    {options.map((m) => (
                      <option key={m} value={m}>
                        {m.replace("gpt-", "")}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            );
          })}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-text-secondary">
          <label
            className="flex items-center gap-1 cursor-pointer select-none"
            title="Generate an instrumental background bed for this cut (via Suno) once the storyboard is ready"
          >
            <input
              type="checkbox"
              checked={musicEnabled}
              disabled={!ready || running}
              onChange={(e) => onMusicEnabledChange(e.target.checked)}
            />
            music
          </label>
        </div>
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

      {musicState.phase !== "off" && (
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          {musicState.phase === "error" ? (
            <>
              <p className="flex-1 text-red-400">♪ {musicState.error}</p>
              <button
                onClick={onMusicRetry}
                className="underline text-text-secondary hover:text-text-primary shrink-0"
              >
                retry
              </button>
            </>
          ) : (
            <p className="text-text-secondary">{musicStatusLine(musicState, musicElapsedS)}</p>
          )}
        </div>
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
              refine(feedback.trim(), targetS);
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

      {inspectorOpen && (
        <PromptInspectorModal
          messages={state.messages}
          onClose={() => setInspectorOpen(false)}
        />
      )}
    </div>
  );
}
