/**
 * Public-target boot (wizz.video). Deliberately NO posthog (public analytics
 * = SimpleAnalytics on the landing page only, per plan §7), NO service worker
 * (the lab's stale-SW gotcha; nginx serves index.html no-cache instead), and
 * no eager editor/font init — the editor tree loads behind the "Open in
 * editor" one-way door. WS-D owns everything under src/publicapp/.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import PublicApp from "./PublicApp";

export function bootPublic(root: HTMLElement) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <PublicApp />
    </React.StrictMode>,
  );
}
