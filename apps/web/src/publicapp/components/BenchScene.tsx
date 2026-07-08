/**
 * The bench (docs/wizz-ui-draft.html's data-scene="bench") — analyzing AND
 * ready both live here (the bench is not a wizard: the direction panel stays
 * interactive throughout analysis). Two columns: footage zone + direction
 * panel.
 */
import { useEffect, useRef, useState } from "react";
import type { PublicClip } from "../../publicflow/types";
import { fmtBatchLine, fmtClipsSummary, fmtEtaLeft } from "../format";
import { useFlow } from "../flow-context";
import { useToast } from "./Toast";
import { Chrome } from "./Chrome";
import { ClipRow } from "./ClipRow";
import { DirectionPanel } from "./DirectionPanel";

function sumKnownDurations(clips: PublicClip[]): number | null {
  const known = clips.map((c) => c.durationS).filter((d): d is number => d !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

export function BenchScene() {
  const { state, pipeline, actions, track } = useFlow();
  const toast = useToast();
  const [dragActive, setDragActive] = useState(false);
  const prevErrorIdsRef = useRef<Set<string>>(new Set());

  // analyze_failed telemetry — fired once per clip the moment it FIRST
  // errors (not on every re-render while it stays errored).
  useEffect(() => {
    const errored = pipeline.clips.filter((c) => c.status.kind === "error");
    for (const c of errored) {
      if (!prevErrorIdsRef.current.has(c.id)) {
        const message = c.status.kind === "error" ? c.status.message : "";
        track("analyze_failed", { clipId: c.id, message });
      }
    }
    prevErrorIdsRef.current = new Set(errored.map((c) => c.id));
  }, [pipeline.clips, track]);

  if (state.name !== "bench") return null;

  const fleetLine = pipeline.batch
    ? fmtBatchLine(pipeline.batch.currentIndex, pipeline.batch.total, pipeline.batch.reanalyzing)
    : pipeline.clips.length > 0
      ? `All footage understood — ${fmtClipsSummary(pipeline.clips.length, sumKnownDurations(pipeline.clips))}`
      : "Drop clips to begin";
  const fleetEta = pipeline.batch ? fmtEtaLeft(pipeline.batch.etaS ?? 0) : "";

  return (
    <div>
      <Chrome />
      <div className="wrap">
        <div className="bench">
          <div>
            <div className="zone-title">
              <span className="label">Your footage</span>
              <button
                className="btn-quiet"
                style={{ fontSize: 12.5 }}
                onClick={() => {
                  void actions.addFilesFromPicker();
                  toast.show("Drop more clips any time — they join the queue.");
                }}
              >
                + add clips
              </button>
            </div>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                void actions.addFilesFromDataTransfer(e.dataTransfer.items);
              }}
            >
              {pipeline.clips.length > 0 && (
                <div className="fleet">
                  <strong>{fleetLine}</strong>
                  {fleetEta && (
                    <span className="tc" style={{ color: "var(--dim)" }}>
                      {fleetEta}
                    </span>
                  )}
                </div>
              )}
              <div className="clips">
                {pipeline.clips.map((clip) => (
                  <ClipRow
                    key={clip.id}
                    clip={clip}
                    onRemove={() => actions.removeClip(clip.id)}
                    onRetry={() => actions.retryClip(clip.id)}
                  />
                ))}
                {pipeline.clips.length === 0 && (
                  <div
                    className="dropzone"
                    role="button"
                    tabIndex={0}
                    data-drag-active={dragActive || undefined}
                    onClick={() => void actions.addFilesFromPicker()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void actions.addFilesFromPicker();
                    }}
                  >
                    <h3 className="display">Drop your clips here</h3>
                    <p className="promise">
                      Films are made here, on this machine. Your footage never leaves it.
                    </p>
                    <button
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void actions.addFilesFromPicker();
                      }}
                    >
                      Choose files…
                    </button>
                  </div>
                )}
              </div>
              {pipeline.lastRefusal && (
                <div className="refusal">
                  {pipeline.lastRefusal.count} clip{pipeline.lastRefusal.count === 1 ? "" : "s"}{" "}
                  skipped — that's more than one cut can take at once ({pipeline.cap.maxClips}{" "}
                  clips max).
                </div>
              )}
              <div className="card stt">
                <label className="toggle" style={{ marginTop: 1 }}>
                  <input
                    type="checkbox"
                    checked={pipeline.cloudSTT}
                    onChange={(e) => pipeline.setCloudSTT(e.target.checked)}
                  />
                </label>
                <span>
                  <strong style={{ color: "var(--ink)" }}>Cloud speech transcription.</strong>{" "}
                  Audio — never video — is transcribed in the cloud for sharper dialogue cuts.
                  Turn it off and everything stays fully local.
                </span>
              </div>
            </div>
          </div>
          <DirectionPanel />
        </div>
      </div>
    </div>
  );
}
