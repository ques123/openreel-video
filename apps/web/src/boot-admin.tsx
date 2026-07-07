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
import { registerServiceWorker } from "./services/service-worker";
import { initCustomFonts } from "./components/editor/inspector/font-options";

export function bootAdmin(root: HTMLElement) {
  const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
  const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

  if (POSTHOG_KEY && POSTHOG_HOST) {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: true,
      capture_pageleave: true,
    });
  }

  registerServiceWorker().then((registration) => {
    if (registration) {
    }
  });

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
