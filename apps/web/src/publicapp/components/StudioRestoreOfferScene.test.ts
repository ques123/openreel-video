/**
 * The scene itself isn't unit-rendered (no publicapp scene is — they're
 * exercised end to end through `?mock=1`); this covers the one piece of
 * logic in the file, the clips-hint copy. ../flow-context is module-mocked
 * so importing the scene doesn't drag the whole generate-flow hook graph
 * into a test that only needs a pure string helper.
 */
import { describe, expect, it, vi } from "vitest";
import { restoreOfferSubtitle } from "./StudioRestoreOfferScene";

vi.mock("../flow-context", () => ({ useFlow: vi.fn() }));

describe("restoreOfferSubtitle", () => {
  it("makes no analysis claim when rememberedCount is unknowable (legacy session)", () => {
    expect(restoreOfferSubtitle(12, null)).toBe("12 clips");
  });

  it("claims analyzed-and-remembered only when every clip's analysis survived", () => {
    expect(restoreOfferSubtitle(12, 12)).toBe("12 clips · analyzed and remembered");
  });

  it("warns of a full re-analysis when nothing survived", () => {
    expect(restoreOfferSubtitle(12, 0)).toBe("12 clips · footage will be re-analyzed");
  });

  it("splits the counts when only part of the cache survived", () => {
    expect(restoreOfferSubtitle(12, 9)).toBe("12 clips · 9 remembered, 3 will be re-analyzed");
  });

  it("keeps the singular form for a one-clip session", () => {
    expect(restoreOfferSubtitle(1, 1)).toBe("1 clip · analyzed and remembered");
    expect(restoreOfferSubtitle(1, null)).toBe("1 clip");
  });
});
