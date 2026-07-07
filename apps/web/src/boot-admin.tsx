/**
 * Admin-target boot — byte-for-byte today's app startup (posthog, service
 * worker, custom fonts, <App/>), moved out of main.tsx so the target picker
 * can dead-code-eliminate the entire tree from the public bundle. WS-C wraps
 * App in the admin shell; this file's job is only "boot exactly what booted
 * before".
 */
import React from "react";
import ReactDOM from "react-dom/client";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import App from "./App";
import { initCustomFonts } from "./components/editor/inspector/font-options";

/**
 * The wizz admin panel is an always-online tailnet tool — a service worker
 * gives it nothing but the documented stale-bundle trap (openreel's sw.js is
 * byte-stable across deploys, so even a no-cache re-fetch never fires an
 * update event, and its runtime cache keeps serving old hashed assets — this
 * is exactly what served a stale editor bundle over the fresh admin deploy).
 * So the admin build, like the public build, ships NO service worker AND
 * actively evicts any one a prior deploy registered, so a redeploy is always
 * immediately live without a manual unregister.
 */
function purgeServiceWorkers(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {});
  if (typeof caches !== "undefined") {
    void caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {});
  }
}

export function bootAdmin(root: HTMLElement) {
  // The admin build is the wizz.pbrain.dev admin PANEL — landing on a bare
  // URL should open the admin shell (the lab, with the sidebar to Users/
  // Usage/Presets/System), not the editor's welcome screen. Default an empty
  // hash to #/lab; a hash the admin typed (#/users, #/editor, …) is honored.
  if (!window.location.hash || window.location.hash === "#" || window.location.hash === "#/") {
    window.location.hash = "#/lab";
  }

  const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
  const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

  if (POSTHOG_KEY && POSTHOG_HOST) {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: true,
      capture_pageleave: true,
    });
  }

  purgeServiceWorkers();

  void initCustomFonts();

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {POSTHOG_KEY && POSTHOG_HOST ? (
        <PostHogProvider client={posthog}>
          <App />
        </PostHogProvider>
      ) : (
        <App />
      )}
    </React.StrictMode>,
  );
}
