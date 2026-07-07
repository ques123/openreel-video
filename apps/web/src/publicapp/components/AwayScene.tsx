/**
 * Director away (docs/wizz-ui-draft.html's data-scene="away") — kill_switch
 * or upstream_error (contracts §7). Same visual language as the gate
 * (.gate-card), with the minimal chrome header the wireframe shows here.
 */
import { useFlow } from "../flow-context";
import { Chrome } from "./Chrome";

export function AwayScene() {
  const { state, actions } = useFlow();
  if (state.name !== "service-away") return null;

  return (
    <div>
      <Chrome minimal />
      <div className="card gate-card">
        <div className="label" style={{ marginBottom: 12 }}>
          Back soon
        </div>
        <h2 className="display" style={{ fontSize: 22, marginBottom: 12 }}>
          The director is taking a break
        </h2>
        <p style={{ color: "var(--dim)", marginBottom: 22 }}>
          Your footage and setup are safe on this machine. Try again in a little while.
        </p>
        <button className="btn" onClick={actions.retry}>
          Back to my footage
        </button>
      </div>
    </div>
  );
}
