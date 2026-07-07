/**
 * Quota-exceeded — "machinery only" per plan §7 (v1 ships unlimited
 * defaults; this scene exists so the machinery is real and testable, not so
 * it's expected to fire in practice). Not in the wireframe; built in the
 * same visual language as the away scene (.gate-card) since both are
 * "can't proceed right now, your work is safe" moments. Copy is
 * category + resetsAt rendered in plain words (format.ts).
 */
import { capitalize, fmtQuotaCategory, fmtResetsAt } from "../format";
import { useFlow } from "../flow-context";
import { Chrome } from "./Chrome";

export function QuotaExceededScene() {
  const { state, actions } = useFlow();
  if (state.name !== "quota-exceeded") return null;

  return (
    <div>
      <Chrome minimal />
      <div className="card gate-card">
        <div className="label" style={{ marginBottom: 12 }}>
          One thing first
        </div>
        <h2 className="display" style={{ fontSize: 22, marginBottom: 12 }}>
          {capitalize(fmtQuotaCategory(state.category))} is spent
        </h2>
        <p style={{ color: "var(--dim)", marginBottom: 22 }}>
          {capitalize(fmtResetsAt(state.resetsAt))}. Your footage and setup are safe on this
          machine.
        </p>
        <button className="btn" onClick={actions.retry}>
          Back to my footage
        </button>
      </div>
    </div>
  );
}
