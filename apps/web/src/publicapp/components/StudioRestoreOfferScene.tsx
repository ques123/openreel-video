/**
 * Returning studio (docs/wizz-ui-draft.html's data-scene="studio-return").
 * The moved-files variant lives in the SAME card (not a separate scene) per
 * the wireframe: clicking "Reload my footage" restores what it can; if some
 * clips moved, the card shows the degrade note with a "Continue with N
 * clips" button that proceeds with just the healthy ones, per
 * services/file-handles.ts's restoreSession.
 */
import { useFlow } from "../flow-context";
import { Chrome } from "./Chrome";

export function StudioRestoreOfferScene() {
  const { state, actions, restoreProgress } = useFlow();
  if (state.name !== "studio-restore-offer") return null;
  const { restoring, movedNames } = restoreProgress;
  const showMoved = movedNames !== null && movedNames.length > 0;

  return (
    <div>
      <Chrome />
      <div className="wrap">
        <div className="card return-card">
          <div className="label" style={{ marginBottom: 10 }}>
            Welcome back
          </div>
          <h2 className="display" style={{ fontSize: 22 }}>
            Reload {state.label}?
          </h2>
          <p className="clips-hint">
            {state.clipCount} clip{state.clipCount === 1 ? "" : "s"} · analyzed and remembered
          </p>
          <button
            className="btn btn-primary"
            onClick={() => void actions.acceptRestore()}
            disabled={restoring}
          >
            {restoring ? "Reloading…" : "Reload my footage"}
          </button>
          <button className="btn-quiet" style={{ marginTop: 6 }} onClick={actions.declineRestore}>
            Start something new instead
          </button>
          <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 18 }}>
            Your browser will ask permission to re-open the files — read-only, and you can revoke
            it in site settings any time.
          </p>
          {showMoved && movedNames && (
            <div className="moved">
              <strong>
                {movedNames.length} clip{movedNames.length === 1 ? " has" : "s have"} moved since
                last time.
              </strong>
              <br />
              {movedNames.join(", ")} {movedNames.length === 1 ? "isn't" : "aren't"} where{" "}
              {movedNames.length === 1 ? "it was" : "they were"} — drop{" "}
              {movedNames.length === 1 ? "it" : "them"} again and everything else carries on.
              <div style={{ marginTop: 8 }}>
                <button className="btn" onClick={actions.continueAfterMovedFiles}>
                  Continue with {Math.max(0, state.clipCount - movedNames.length)} clips
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
