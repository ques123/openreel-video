import { useEffect, useState } from "react";
import { stylePresetById } from "@openreel/core";
import {
  buildExperimentsExport,
  deleteExperiment,
  experimentAuxCostUSD,
  experimentAuxUsage,
  experimentCaptionCostUSD,
  fmtDurationMs,
  fmtTokens,
  loadExperiment,
  saveExperiment,
  type DirectorExperiment,
} from "../../../services/experiments";
import { estimateCostUSD, fmtUSD } from "../../../services/model-pricing";
import { proxiedMusicUrl } from "../../../services/suno";
import { ConfirmButton } from "./ConfirmButton";
import { downloadJson } from "./download-json";
import { PromptInspectorModal } from "./PromptInspectorModal";

interface ExperimentDetailModalProps {
  experimentId: string;
  /** File names (from the experiment's clip refs) missing from this session. */
  missingFiles: (exp: DirectorExperiment) => string[];
  onWatch: (exp: DirectorExperiment) => void;
  onExportDebug: (exp: DirectorExperiment) => void;
  exportProgress: string | null;
  /** Compile this cut into a real editable timeline (#/editor). */
  onCompile: (exp: DirectorExperiment) => void;
  compiling: boolean;
  /** Progress (or blocking-error) line for a compile ("importing 2/5…"). */
  compileProgress: string | null;
  onDeleted: () => void;
  /** A field on the stored record changed (e.g. committed music track). */
  onChanged?: () => void;
  onClose: () => void;
}

function fmtS(v: number): string {
  return v.toFixed(1) + "s";
}

/** Full record of one director run: settings, results, conversation, actions. */
export function ExperimentDetailModal({
  experimentId,
  missingFiles,
  onWatch,
  onExportDebug,
  exportProgress,
  onCompile,
  compiling,
  compileProgress,
  onDeleted,
  onChanged,
  onClose,
}: ExperimentDetailModalProps) {
  const [exp, setExp] = useState<DirectorExperiment | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);

  /** Persist a committed track onto the stored record (survives refresh). */
  const commitTrack = (trackId: string) => {
    setExp((prev) => {
      if (!prev?.music) return prev;
      const next = {
        ...prev,
        updatedAt: Date.now(),
        music: { ...prev.music, committedTrackId: trackId },
      };
      void saveExperiment(next).catch(() => undefined);
      onChanged?.();
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    void loadExperiment(experimentId).then((loaded) => {
      if (!cancelled) setExp(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [experimentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !conversationOpen) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, conversationOpen]);

  if (!exp) return null;
  const missing = missingFiles(exp);
  const src = exp.promptSources;
  const stats = exp.captionStats;
  const capTokens = stats ? stats.cloudPromptTokens + stats.cloudCompletionTokens : 0;
  const capMs = stats ? stats.cloudMs + stats.localMs : 0;
  const capFrames = stats ? stats.cloudFrames + stats.localFrames : 0;
  const cachedTokens = exp.usage.cachedTokens ?? 0;
  const dirCost = estimateCostUSD(
    exp.model,
    exp.usage.promptTokens,
    exp.usage.completionTokens,
    cachedTokens,
  );
  const capCost = experimentCaptionCostUSD(exp);
  const aux = experimentAuxUsage(exp);
  const auxIn = aux.reduce((sum, u) => sum + u.promptTokens, 0);
  const auxOut = aux.reduce((sum, u) => sum + u.completionTokens, 0);
  const auxCost = experimentAuxCostUSD(aux);
  const stylePreset = stylePresetById(exp.styleId);
  const violation = exp.durationViolation;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-background-secondary border border-border rounded-xl overflow-hidden max-w-3xl w-full flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              {exp.storyboard?.title ?? "Experiment"}
            </p>
            <p className="text-xs text-text-secondary font-mono">
              {new Date(exp.at).toISOString().replace("T", " ").slice(0, 16)} UTC ·{" "}
              {exp.model} · {exp.usage.calls} LLM calls
              {exp.usage.promptTokens + exp.usage.completionTokens > 0
                ? ` · ${fmtTokens(exp.usage.promptTokens)} in / ${fmtTokens(exp.usage.completionTokens)} out tok`
                : ""}
              {cachedTokens > 0 ? ` (${fmtTokens(cachedTokens)} cached)` : ""}
              {exp.usage.promptTokens + exp.usage.completionTokens > 0 && dirCost !== null
                ? ` ≈${fmtUSD(dirCost)}`
                : ""}
              {exp.durationMs > 0 ? ` · ${fmtDurationMs(exp.durationMs)} thinking` : ""}
            </p>
            {(exp.captionModels || stats) && (
              <p className="text-xs text-text-secondary font-mono">
                captions: {exp.captionModels || "local-only"}
                {stats && capFrames > 0 ? ` · ${capFrames} frames` : ""}
                {stats && capTokens > 0
                  ? ` · ${fmtTokens(stats.cloudPromptTokens)} in / ${fmtTokens(stats.cloudCompletionTokens)} out tok`
                  : ""}
                {stats && capTokens > 0 && capCost !== null ? ` ≈${fmtUSD(capCost)}` : ""}
                {stats && capMs > 0 ? ` · ${fmtDurationMs(capMs)}` : ""}
              </p>
            )}
            {auxIn + auxOut > 0 && (
              <p className="text-xs text-text-secondary font-mono">
                aux (brief/music): {aux.length} call{aux.length === 1 ? "" : "s"} ·{" "}
                {fmtTokens(auxIn)} in / {fmtTokens(auxOut)} out tok
                {auxCost !== null ? ` ≈${fmtUSD(auxCost)}` : ""}
              </p>
            )}
          </div>
          <button
            className="text-text-secondary hover:text-text-primary text-xl px-2"
            onClick={onClose}
            aria-label="Close experiment"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3 text-xs">
          {violation && (
            <div className="border border-amber-500/50 bg-amber-500/10 text-amber-500 rounded-md px-2.5 py-1.5">
              <span className="font-semibold">Duration target missed:</span> asked{" "}
              {fmtS(violation.targetS)}, model submitted {fmtS(violation.submittedS)} (
              {violation.direction})
              {violation.trimmed
                ? ` — mechanically trimmed to ${fmtS(violation.deliveredS)}.`
                : ` — delivered as-is at ${fmtS(violation.deliveredS)}.`}
            </div>
          )}
          <div>
            <p className="font-semibold text-text-primary mb-0.5">
              Brief
              {exp.briefAngle && (
                <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded border border-primary/40 text-primary font-normal">
                  {exp.briefAngle}
                </span>
              )}
              {exp.styleId && (
                <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded border border-border text-text-secondary font-normal">
                  {stylePresetById(exp.styleId)?.label ?? exp.styleId}
                </span>
              )}
            </p>
            <p className="text-text-secondary whitespace-pre-wrap">{exp.brief}</p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-text-secondary">
            <span>target: {exp.targetDurationS ? fmtS(exp.targetDurationS) : "none"}</span>
            <span>
              sources: local={String(src.localCaptions)} cloudShots={String(src.cloudShots)}{" "}
              cloudTimeline={String(src.cloudTimeline)} transcript={String(src.transcript)}{" "}
              mode={src.promptMode ?? "full"}
            </span>
            <span>
              clips: {exp.clips.map((c) => c.fileName).join(", ")}
            </span>
            {stylePreset && <span>style: {stylePreset.label}</span>}
          </div>
          {exp.metrics && (
            <p className="text-text-secondary font-mono text-[11px]">
              <span title="cut points landing >150ms inside a spoken word (after boundary snapping) — lower is better">
                cuts in speech: {(exp.metrics.midSpeechCutFraction * 100).toFixed(0)}% (
                {exp.metrics.midSpeechCutCount}/{exp.metrics.cutCount})
              </span>
              {exp.metrics.adjacentCosineMean !== null && (
                <span title="cosine similarity between adjacent segments' shot embeddings — near 1 means near-identical back-to-back shots">
                  {" "}
                  · adj-sim: {exp.metrics.adjacentCosineMean.toFixed(2)} mean /{" "}
                  {(exp.metrics.adjacentCosineMax ?? 0).toFixed(2)} max (
                  {exp.metrics.adjacentPairCount} pairs)
                </span>
              )}
            </p>
          )}

          {exp.storyboard && (
            <div>
              <p className="font-semibold text-text-primary mb-1">
                Storyboard — {exp.storyboard.items.length} segments
              </p>
              {exp.storyboard.notes && (
                <p className="text-text-secondary italic mb-1">{exp.storyboard.notes}</p>
              )}
              <ol className="space-y-1">
                {exp.storyboard.items.map((it, i) => (
                  <li key={i} className="text-text-secondary">
                    <span className="font-mono text-text-primary">
                      {i + 1}. [{it.role}] {fmtS(it.inS)}–{fmtS(it.outS)}
                    </span>{" "}
                    {it.why}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {exp.music && exp.music.tracks.length > 0 && (
            <div>
              <p className="font-semibold text-text-primary mb-1">
                Music — {exp.music.tracks.length} generated takes
                {exp.music.committedTrackId === null && (
                  <span className="text-amber-500 font-normal">
                    {" "}
                    (none committed — debug render will have no bed)
                  </span>
                )}
              </p>
              <div className="space-y-1.5">
                {exp.music.tracks.map((t, i) => {
                  const committed = exp.music!.committedTrackId === t.id;
                  return (
                    <div key={t.id} className="flex items-center gap-2">
                      <span className="font-mono text-text-primary whitespace-nowrap">
                        take {i + 1}/{exp.music!.tracks.length}
                      </span>
                      <audio
                        controls
                        preload="none"
                        crossOrigin="anonymous"
                        src={proxiedMusicUrl(t.audioUrl || t.streamAudioUrl)}
                        className="h-7 flex-1 min-w-0"
                      />
                      <button
                        className={`px-2 py-1 text-xs rounded-md border whitespace-nowrap ${
                          committed
                            ? "border-primary text-primary"
                            : "border-border text-text-secondary hover:text-text-primary"
                        }`}
                        onClick={() => commitTrack(t.id)}
                        title="Bake this take into the debug render"
                      >
                        {committed ? "✓ in render" : "use in render"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {missing.length > 0 && (
            <p className="text-amber-500">
              Re-add these files to watch/export/compile with real footage: {missing.join(", ")}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-t border-border">
          <button
            className="px-3 py-1 text-sm rounded-md bg-primary text-white disabled:opacity-40"
            disabled={!exp.storyboard || missing.length > 0}
            onClick={() => onWatch(exp)}
            title={missing.length > 0 ? "Some source files are not in this session" : "Play this cut"}
          >
            ▶ Watch
          </button>
          <button
            className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
            disabled={!exp.storyboard || exportProgress !== null}
            onClick={() => onExportDebug(exp)}
          >
            {exportProgress ?? "⬇ debug video"}
          </button>
          <button
            className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
            disabled={
              !exp.storyboard ||
              exp.storyboard.items.length === 0 ||
              compiling ||
              exportProgress !== null ||
              missing.length > 0
            }
            onClick={() => onCompile(exp)}
            title={
              missing.length > 0
                ? `Missing from this session, re-drop: ${missing.join(", ")}`
                : "Compile this cut into a real editable timeline in the editor"
            }
          >
            {compileProgress ?? "⧉ open in editor"}
          </button>
          <button
            className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary"
            onClick={() => setConversationOpen(true)}
          >
            conversation →
          </button>
          <button
            className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary"
            onClick={() => downloadJson(`openreel-experiment-${exp.id}.json`, buildExperimentsExport([exp]))}
            title="Download this run's full record as JSON (settings, conversation, storyboard, usage — the rendered video is not included)"
          >
            ⬇ json
          </button>
          <div className="flex-1" />
          <ConfirmButton
            className="px-2 py-1 text-xs rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10"
            armedClassName="bg-red-500/10"
            confirmLabel="really delete?"
            title="Permanently delete this run and its rendered video"
            onConfirm={() => {
              void deleteExperiment(exp.id).then(onDeleted);
            }}
          >
            delete
          </ConfirmButton>
        </div>
      </div>

      {conversationOpen && (
        <PromptInspectorModal
          messages={exp.messages}
          onClose={() => setConversationOpen(false)}
        />
      )}
    </div>
  );
}
