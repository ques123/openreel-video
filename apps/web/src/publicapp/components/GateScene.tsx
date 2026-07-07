/**
 * Browser-capability gate (docs/wizz-ui-draft.html's data-scene="gate"). No
 * chrome header in the approved wireframe — just the card. "Back" returns to
 * the real landing page (a separate static site at "/"), so it's a plain
 * anchor, not an in-SPA navigation.
 */
export function GateScene() {
  return (
    <div className="card gate-card">
      <div className="label" style={{ marginBottom: 12 }}>
        One thing first
      </div>
      <h2 className="display" style={{ fontSize: 22, marginBottom: 12 }}>
        The studio runs on your computer's GPU
      </h2>
      <p style={{ color: "var(--dim)", marginBottom: 22 }}>
        That's how your footage stays on your machine. This browser can't do it — open{" "}
        <strong>wizz.video</strong> in <strong>Chrome or Edge on a desktop</strong> and you're in.
      </p>
      <a className="btn" href="/">
        Back
      </a>
    </div>
  );
}
