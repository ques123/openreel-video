import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_STRIP_HEIGHT_PX,
  placeholderStripHeightPx,
  recordStripHeight,
  resetStripHeightForTests,
  shouldRenderShotCards,
} from "./strip-visibility";

describe("shouldRenderShotCards", () => {
  it("always renders strips with no shots (the decoding notice must show)", () => {
    expect(
      shouldRenderShotCards({ shotCount: 0, observerSupported: true, nearViewport: false }),
    ).toBe(true);
  });

  it("never gates when IntersectionObserver is unavailable", () => {
    expect(
      shouldRenderShotCards({ shotCount: 12, observerSupported: false, nearViewport: false }),
    ).toBe(true);
  });

  it("gates offscreen strips and renders near-viewport ones", () => {
    expect(
      shouldRenderShotCards({ shotCount: 12, observerSupported: true, nearViewport: false }),
    ).toBe(false);
    expect(
      shouldRenderShotCards({ shotCount: 12, observerSupported: true, nearViewport: true }),
    ).toBe(true);
  });
});

describe("placeholder strip height", () => {
  afterEach(resetStripHeightForTests);

  it("falls back to the CSS-derived estimate before any strip is measured", () => {
    expect(placeholderStripHeightPx()).toBe(FALLBACK_STRIP_HEIGHT_PX);
  });

  it("uses the last real measurement once one exists", () => {
    recordStripHeight(112);
    expect(placeholderStripHeightPx()).toBe(112);
    recordStripHeight(108);
    expect(placeholderStripHeightPx()).toBe(108);
  });

  it("ignores zero/negative measurements (unlaid-out elements)", () => {
    recordStripHeight(112);
    recordStripHeight(0);
    recordStripHeight(-3);
    expect(placeholderStripHeightPx()).toBe(112);
  });
});
