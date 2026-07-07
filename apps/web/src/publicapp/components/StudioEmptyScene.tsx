/**
 * First-visit studio (docs/wizz-ui-draft.html's data-scene="studio-first"):
 * the dropzone owns the screen with the privacy promise on it; a first-visit
 * model-prep strip warms the studio while the user picks files, and never
 * appears again (driven by PublicPipeline.modelPrep — null once warm, per
 * publicflow/types.ts's doc comment — gated additionally by the flow state's
 * `firstVisit` flag).
 */
import { useState } from "react";
import { useFlow } from "../flow-context";
import { Chrome } from "./Chrome";

export function StudioEmptyScene() {
  const { state, pipeline, actions } = useFlow();
  const [dragActive, setDragActive] = useState(false);
  if (state.name !== "studio-empty") return null;

  const showPrep = state.firstVisit && pipeline.modelPrep !== null;

  return (
    <div>
      <Chrome />
      <div className="wrap">
        <div
          className="dropzone"
          role="button"
          tabIndex={0}
          data-drag-active={dragActive || undefined}
          onClick={() => void actions.addFilesFromPicker()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void actions.addFilesFromPicker();
          }}
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
          <h3 className="display">Drop your clips here</h3>
          <p className="promise">Films are made here, on this machine. Your footage never leaves it.</p>
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
        {showPrep && pipeline.modelPrep && (
          <div className="prep-strip">
            <span>
              {pipeline.modelPrep.done
                ? "Studio ready — models are on this machine now"
                : "Preparing your studio — one-time download"}
            </span>
            <div className="bar">
              <i style={{ width: `${pipeline.modelPrep.progress}%` }} />
            </div>
            <span className="tc">
              {pipeline.modelPrep.done ? "✓" : `${Math.round(pipeline.modelPrep.progress)}%`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
