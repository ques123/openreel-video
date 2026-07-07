/**
 * Theme cycling for the public product — mirrors the approved wireframe's
 * `cycleTheme()` (docs/wizz-ui-draft.html): "auto" defers to
 * prefers-color-scheme (wizz-tokens.css's @media block), an explicit
 * dark/light choice stamps `data-theme` on `<html>` and wins in both
 * directions (wizz-tokens.css's `:root[data-theme=...]` blocks). Persisted
 * under its own localStorage key — deliberately NOT the admin app's
 * "openreel-theme" (useThemeStore), since the two products' theme choices
 * are independent and this bundle must not import admin state.
 */
import { useCallback, useEffect, useState } from "react";

export type WizzThemeMode = "auto" | "dark" | "light";

const STORAGE_KEY = "wizz:theme";
const CYCLE: readonly WizzThemeMode[] = ["auto", "dark", "light"];

export function loadStoredTheme(): WizzThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return (CYCLE as readonly string[]).includes(stored ?? "") ? (stored as WizzThemeMode) : "auto";
  } catch {
    return "auto";
  }
}

function persistTheme(mode: WizzThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private browsing / quota — the choice still applies for this session.
  }
}

/** Stamps (or clears) `data-theme` on `<html>` per the wireframe's rule. */
export function applyTheme(mode: WizzThemeMode): void {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
}

export function nextTheme(mode: WizzThemeMode): WizzThemeMode {
  const i = CYCLE.indexOf(mode);
  return CYCLE[(i + 1) % CYCLE.length];
}

export interface UseWizzThemeReturn {
  mode: WizzThemeMode;
  cycle(): void;
}

export function useWizzTheme(): UseWizzThemeReturn {
  const [mode, setMode] = useState<WizzThemeMode>(() => loadStoredTheme());

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  const cycle = useCallback(() => {
    setMode((m) => {
      const next = nextTheme(m);
      persistTheme(next);
      return next;
    });
  }, []);

  return { mode, cycle };
}
