/**
 * Render overlay (docs/wizz-ui-draft.html's #render-overlay): progress bar,
 * timecode, cancel, and a done state naming the downloaded file. Mounted
 * only while `state.screening.rendering` is true (contracts: "render
 * overlay is a screening sub-state").
 */
import { useEffect, useRef, useState } from "react";
import { downloadBlob } from "../../services/debug-export";
import { fmtClockMMSS } from "../format";
import { useFlow } from "../flow-context";
import { RenderCancelledError, renderCut, slugifyTitle, type RenderProgress } from "../render-cut";

export function RenderOverlay() {
  const { state, currentCut, selectedTake, getFileForClip, actions, track } = useFlow();
  const [progress, setProgress] = useState<RenderProgress>({ fraction: 0, elapsedS: 0, totalS: 0 });
  const [doneFilename, setDoneFilename] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  const rendering = state.name === "screening" && state.rendering;

  useEffect(() => {
    // The reset lives in the `!rendering` branch ONLY (not in a returned
    // cleanup function): StrictMode's dev-only double mount/cleanup/mount
    // simulation runs cleanup functions too, and a cleanup that
    // unconditionally reset `startedRef` would let that synchronous replay
    // kick off a SECOND concurrent renderCut() call for the same session.
    // Gating the reset on `rendering` itself means it only ever fires on a
    // genuine transition out of the rendering state (Done/Cancel/failure),
    // never on a StrictMode replay of the same (rendering=true) run.
    if (!rendering) {
      startedRef.current = false;
      return;
    }
    if (!currentCut || startedRef.current) return;
    startedRef.current = true;
    setDoneFilename(null);
    setFailed(null);
    setProgress({ fraction: 0, elapsedS: 0, totalS: currentCut.totalS });
    const controller = new AbortController();
    abortRef.current = controller;
    const musicUrl = currentCut.musicTakes
      ? selectedTake === "a"
        ? currentCut.musicTakes.a
        : currentCut.musicTakes.b
      : null;

    renderCut({
      cut: currentCut,
      getFile: getFileForClip,
      musicUrl,
      onProgress: setProgress,
      signal: controller.signal,
    })
      .then((blob) => {
        const filename = `${slugifyTitle(currentCut.title)}.webm`;
        downloadBlob(blob, filename);
        setDoneFilename(filename);
        track("export_completed");
        actions.finishRender();
      })
      .catch((err) => {
        if (err instanceof RenderCancelledError) return; // cancel button already called actions.cancelRender()
        console.error("[wizz] render failed", err);
        setFailed(err instanceof Error ? err.message : String(err));
        track("export_failed", { message: err instanceof Error ? err.message : String(err) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendering, currentCut]);

  if (!rendering) return null;

  const cancel = () => {
    abortRef.current?.abort();
    actions.cancelRender();
  };

  const heading = doneFilename
    ? "Your film is ready"
    : failed
      ? "Rendering hit a snag"
      : `Rendering in real time — about ${fmtClockMMSS(Math.max(0, progress.totalS - progress.elapsedS))}`;

  return (
    <div className="render-overlay">
      <div className="card render-card">
        <div className="label">Rendering</div>
        <h3 className="display" style={{ fontSize: 19, marginTop: 8 }}>
          {heading}
        </h3>
        <div className="bar">
          <i style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
        </div>
        <span className="tc" style={{ color: "var(--dim)" }}>
          {fmtClockMMSS(progress.elapsedS)} / {fmtClockMMSS(progress.totalS)}
        </span>
        {doneFilename && (
          <div style={{ marginTop: 16 }}>
            <p style={{ marginBottom: 14 }}>
              Saved. <strong>{doneFilename}</strong> is in your downloads.
            </p>
            <button className="btn btn-primary" onClick={actions.finishRender}>
              Done
            </button>
          </div>
        )}
        {failed && (
          <div style={{ marginTop: 16 }}>
            <p style={{ marginBottom: 14, color: "var(--bad)" }}>{failed}</p>
            <button className="btn" onClick={cancel}>
              Close
            </button>
          </div>
        )}
        {!doneFilename && !failed && (
          <div style={{ marginTop: 14 }}>
            <button className="btn-quiet" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
