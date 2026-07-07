/**
 * Directing (docs/wizz-ui-draft.html's data-scene="directing"): the
 * director's real activity streams as narrative, search queries verbatim in
 * quotes. `rate_limited` failures don't leave this scene (contracts §7) —
 * they surface as an inline retry note instead.
 */
import { useFlow } from "../flow-context";
import { Chrome } from "./Chrome";

export function DirectingScene() {
  const { state, director, directorRetryNote, actions } = useFlow();
  if (state.name !== "directing") return null;

  const activity = director.phase.kind === "running" ? director.phase.activity : [];

  return (
    <div>
      <Chrome minimal />
      <div className="wrap direct-stage">
        <span className="label">Directing</span>
        <h2 className="display">Cutting your film…</h2>
        <div className="stream">
          {activity.map((line, i) => (
            <div key={i} className={`ln show${i === activity.length - 1 ? " now" : ""}`}>
              <span className="dot">—</span>
              <span>
                {line.isQuery ? (
                  <>
                    Looking for: <span className="q">&quot;{line.text}&quot;</span>
                  </>
                ) : (
                  line.text
                )}
              </span>
            </div>
          ))}
        </div>
        {directorRetryNote && <p className="retry-note">{directorRetryNote} — retrying…</p>}
        <button className="btn-quiet" style={{ marginTop: 26 }} onClick={actions.cancelDirecting}>
          Cancel — keep my setup
        </button>
      </div>
    </div>
  );
}
