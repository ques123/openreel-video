/**
 * Path-based router for the public product (contracts §0: "/app/auth",
 * "/app/generate", "/app/editor"; nginx falls back to /app/index.html — see
 * ops/wizz/nginx-wizz.video.conf). `history.pushState` + popstate, no hash.
 *
 * Base-prefix tolerance: `vite dev`/`vite preview` serve this SPA at the
 * domain root ("/"), while the deployed box serves it under "/app" (the
 * landing page owns "/"). The base helper below detects which one is live
 * from `window.location.pathname` itself, so the SAME built bundle behaves
 * correctly in both — no build-time env needed, no vite.config change.
 */
import { useCallback, useEffect, useState } from "react";

export type PublicRoute = "auth" | "generate" | "editor";

const KNOWN_PREFIXES: readonly PublicRoute[] = ["auth", "generate", "editor"];

/** "/app" when the current document is under that prefix, else "" (dev root). */
export function basePrefix(pathname: string): string {
  return pathname === "/app" || pathname.startsWith("/app/") ? "/app" : "";
}

/** Path segment after the base prefix, always leading-slash, never empty. */
function withoutBase(pathname: string): string {
  const base = basePrefix(pathname);
  const rest = pathname.slice(base.length);
  return rest === "" ? "/" : rest;
}

export function routeFromPath(pathname: string): PublicRoute {
  const rest = withoutBase(pathname).replace(/^\//, ""); // "auth", "editor/foo", ""
  const first = rest.split("/")[0];
  return (KNOWN_PREFIXES as readonly string[]).includes(first) ? (first as PublicRoute) : "generate";
}

/** Builds the full path (with base prefix) for a route, preserving search/hash. */
export function pathFor(route: PublicRoute, pathname: string): string {
  return `${basePrefix(pathname)}/${route}`;
}

export interface PublicRouter {
  route: PublicRoute;
  navigate(route: PublicRoute, opts?: { replace?: boolean }): void;
}

/**
 * At mount, `/app` (and dev-root `/`) canonicalize their URL to `/…/generate`
 * via replaceState — the redirect the contract calls for at `/app`, made a
 * no-op-safe replace so reloading doesn't grow history.
 */
export function useAppRouter(): PublicRouter {
  const [route, setRoute] = useState<PublicRoute>(() => routeFromPath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const { pathname, search, hash } = window.location;
    const rest = withoutBase(pathname);
    if (rest === "/") {
      const canonical = pathFor("generate", pathname);
      window.history.replaceState(null, "", canonical + search + hash);
    }
    // Mount-only: this canonicalizes the initial URL, it does not react to
    // subsequent navigation (navigate() below owns that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback((next: PublicRoute, opts?: { replace?: boolean }) => {
    const path = pathFor(next, window.location.pathname);
    const { search, hash } = window.location;
    const url = path + search + hash;
    if (opts?.replace) window.history.replaceState(null, "", url);
    else if (window.location.pathname !== path) window.history.pushState(null, "", url);
    setRoute(next);
  }, []);

  return { route, navigate };
}
