import { useEffect, useState } from "react";
import {
  deleteExperiment,
  loadExperiment,
  type DirectorExperiment,
} from "../../../services/experiments";
import { PromptInspectorModal } from "./PromptInspectorModal";

interface ExperimentDetailModalProps {
  experimentId: string;
  /** File names (from the experiment's clip refs) missing from this session. */
  missingFiles: (exp: DirectorExperiment) => string[];
  onWatch: (exp: DirectorExperiment) => void;
  onExportDebug: (exp: DirectorExperiment) => void;
  exportProgress: string | null;
  onDeleted: () => void;
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
  onDeleted,
  onClose,
}: ExperimentDetailModalProps) {
  const [exp, setExp] = useState<DirectorExperiment | null>(null);
  const [conversationOpen, setConversationOpen] = useState(false);

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
  const totalTokens = exp.usage.promptTokens + exp.usage.completionTokens;

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
              {totalTokens > 0 ? ` · ${(totalTokens / 1000).toFixed(1)}k tokens` : ""}
              {exp.durationMs > 0 ? ` · ${(exp.durationMs / 1000).toFixed(0)}s thinking` : ""}
            </p>
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
          <div>
            <p className="font-semibold text-text-primary mb-0.5">Brief</p>
            <p className="text-text-secondary whitespace-pre-wrap">{exp.brief}</p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-text-secondary">
            <span>target: {exp.targetDurationS ? fmtS(exp.targetDurationS) : "none"}</span>
            <span>
              sources: local={String(src.localCaptions)} cloudShots={String(src.cloudShots)}{" "}
              cloudTimeline={String(src.cloudTimeline)} transcript={String(src.transcript)}
            </span>
            <span>
              clips: {exp.clips.map((c) => c.fileName).join(", ")}
            </span>
          </div>

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

          {missing.length > 0 && (
            <p className="text-amber-500">
              Re-add these files to watch/export with real footage: {missing.join(", ")}
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
            className="px-2 py-1 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary"
            onClick={() => setConversationOpen(true)}
          >
            conversation →
          </button>
          <div className="flex-1" />
          <button
            className="px-2 py-1 text-xs rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10"
            onClick={() => {
              void deleteExperiment(exp.id).then(onDeleted);
            }}
          >
            delete
          </button>
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
