/**
 * wizz.video public product root — WS-D builds the real thing here against
 * the approved wireframe (docs/wizz-ui-draft.html) and §10 of the plan.
 * This stub exists so the main.tsx target branch compiles and the public
 * build produces a bundle before Wave 2 lands.
 *
 * File ownership: everything under src/publicapp/ belongs to WS-D. Shared
 * files (main.tsx, App.tsx, vite.config.ts, router hooks) belong to WS-C.
 */
import "../styles/wizz-tokens.css";

export default function PublicApp() {
  return (
    <div
      className="wizz"
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--ground)",
        color: "var(--dim)",
        fontFamily: "var(--font-body)",
      }}
    >
      <p>wizz.video — under construction</p>
    </div>
  );
}
