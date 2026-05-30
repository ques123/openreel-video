import { describe, it, expect } from "vitest";
import { getTabIdsForClipType, getTabsForClipType, TAB_DEFS } from "./clip-tabs.config";

describe("clip-tabs.config", () => {
  it("video has all 7 media tabs in workflow order", () => {
    expect(getTabIdsForClipType("video")).toEqual([
      "transform", "color", "effects", "audio", "speed", "animate", "ai",
    ]);
  });

  it("image drops audio and speed", () => {
    expect(getTabIdsForClipType("image")).toEqual([
      "transform", "color", "effects", "animate", "ai",
    ]);
  });

  it("audio clip shows only audio and speed", () => {
    expect(getTabIdsForClipType("audio")).toEqual(["audio", "speed"]);
  });

  it("text/shape/svg/sticker share transform/style/animate/ai", () => {
    for (const t of ["text", "shape", "svg", "sticker"] as const) {
      expect(getTabIdsForClipType(t)).toEqual(["transform", "style", "animate", "ai"]);
    }
  });

  it("null clip type yields no tabs", () => {
    expect(getTabIdsForClipType(null)).toEqual([]);
    expect(getTabsForClipType(null)).toEqual([]);
  });

  it("getTabsForClipType returns defs with labels and icons", () => {
    const defs = getTabsForClipType("video");
    expect(defs[0]).toMatchObject({ id: "transform", label: "Transform" });
    expect(typeof defs[0].icon).toBe("object");
    expect(Object.keys(TAB_DEFS)).toHaveLength(8);
  });
});
