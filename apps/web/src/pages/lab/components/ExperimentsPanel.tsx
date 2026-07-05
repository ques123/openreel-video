import { useEffect, useState } from "react";
import {
  experimentCostLine,
  listExperiments,
  type ExperimentSummary,
} from "../../../services/experiments";

interface ExperimentsPanelProps {
  /** Change this value to make the panel re-read the index (new run saved). */
  refreshToken: unknown;
  onOpen: (id: string) => void;
  onCompareGrid: () => void;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(5, 16);
}

function srcBadge(s: ExperimentSummary): string {
  const parts: string[] = [];
  if (s.promptSources.localCaptions) parts.push("local");
  if (s.promptSources.cloudShots) parts.push("c·shots");
  if (s.promptSources.cloudTimeline) parts.push("c·timeline");
  if (s.promptSources.transcript) parts.push("script");
  return parts.join("+") || "no sources";
}

/**
 * Every director run ever made on this machine, newest first — settings,
 * conversation and storyboard are all persisted, so experiments survive
 * reloads and can be re-watched/exported later.
 */
export function ExperimentsPanel({ refreshToken, onOpen, onCompareGrid }: ExperimentsPanelProps) {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetch = () =>
      void listExperiments().then((list) => {
        if (!cancelled) setExperiments(list);
      });
    fetch();
    // The refresh token flips in the same tick the run completes — the async
    // IndexedDB save may still be in flight, so look again shortly after.
    const late = setTimeout(fetch, 2500);
    return () => {
      cancelled = true;
      clearTimeout(late);
    };
  }, [refreshToken]);

  if (experiments.length === 0) return null;

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <h3 className="text-sm font-semibold text-text-primary mb-2 flex items-center">
        Experiments
        <span className="font-normal text-text-secondary ml-1.5">{experiments.length}</span>
        <span className="flex-1" />
        <button
          className="text-[10px] font-normal px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary"
          onClick={onCompareGrid}
          title="Watch experiment renders side by side with setting differences highlighted"
        >
          compare grid ⊞
        </button>
      </h3>
      <ul className="space-y-1 max-h-60 overflow-y-auto">
        {experiments.map((e) => {
          const cost = experimentCostLine(e);
          return (
            <li
              key={e.id}
              className="text-xs rounded px-1.5 py-1 hover:bg-background cursor-pointer"
              onClick={() => onOpen(e.id)}
            >
              <p className="text-text-primary truncate">
                {e.title ?? e.brief.slice(0, 60) ?? "(untitled)"}
              </p>
              <p className="text-text-secondary font-mono text-[10px]">
                {fmtWhen(e.updatedAt)} · {e.itemCount} segs · {srcBadge(e)}
              </p>
              {cost && (
                <p className="text-text-secondary/70 font-mono text-[10px] truncate">{cost}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
