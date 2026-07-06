/**
 * Viewport gating for the shot filmstrips: at ~90 clips the page would mount
 * hundreds of inline base64 <img>s in one column, so each strip renders its
 * real shot cards only while it is within ~one screen of the viewport
 * (STRIP_VIEWPORT_MARGIN_PX). Offscreen strips render empty fixed-size cells
 * that keep BOTH scroll geometry and the per-shot `shot-<clipId>-<index>`
 * anchor ids stable — scrollToShot in PerceptionLabPage targets those ids
 * from search hits and transcript clicks, and the smooth scroll materializes
 * the strip as soon as it comes within the margin.
 *
 * Decision logic lives here as pure functions (unit-tested); jsdom has no
 * IntersectionObserver, so the DOM glue stays thin and feature-checked.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

/** How far outside the viewport a strip starts rendering its images. */
export const STRIP_VIEWPORT_MARGIN_PX = 600;

/**
 * Placeholder row height until any strip has been measured: border-2 card
 * (140px-content-wide aspect-video image ≈ 79px + one 10px/1.5 caption line
 * with py-1 ≈ 23px + 4px borders) + the row's pb-1 ≈ 110. A real measurement
 * replaces it as soon as the first strip renders.
 */
export const FALLBACK_STRIP_HEIGHT_PX = 110;

/**
 * Last measured height of a rendered strip row. Every strip shares identical
 * card CSS, so one measurement is right for all placeholders — including
 * strips that have never been on screen.
 */
let measuredStripHeightPx: number | null = null;

export function recordStripHeight(px: number): void {
  if (px > 0) measuredStripHeightPx = px;
}

/** Height a placeholder strip row occupies so page scroll geometry holds. */
export function placeholderStripHeightPx(): number {
  return measuredStripHeightPx ?? FALLBACK_STRIP_HEIGHT_PX;
}

/** Test-only: reset the module-level measurement. */
export function resetStripHeightForTests(): void {
  measuredStripHeightPx = null;
}

export function intersectionObserverSupported(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

/**
 * Whether a strip should render its real shot cards.
 * - No shots yet: nothing heavy to gate (the "decoding…" notice has its own
 *   height and must stay visible) — always render.
 * - No IntersectionObserver (jsdom, ancient browsers): never gate.
 */
export function shouldRenderShotCards(opts: {
  shotCount: number;
  observerSupported: boolean;
  nearViewport: boolean;
}): boolean {
  if (opts.shotCount === 0) return true;
  if (!opts.observerSupported) return true;
  return opts.nearViewport;
}

/**
 * True while `ref`'s element is within `marginPx` of the viewport. Starts
 * false (when observable) so the initial 91-clip mount doesn't decode every
 * thumbnail at once; on-screen strips flip on in the observer's first
 * callback, one frame after mount.
 */
export function useNearViewport<T extends Element>(marginPx: number): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(() => !intersectionObserverSupported());
  useEffect(() => {
    const el = ref.current;
    if (!el || !intersectionObserverSupported()) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Single target: the last entry is the freshest.
        const entry = entries[entries.length - 1];
        if (entry) setNear(entry.isIntersecting);
      },
      { rootMargin: `${marginPx}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [marginPx]);
  return [ref, near];
}
