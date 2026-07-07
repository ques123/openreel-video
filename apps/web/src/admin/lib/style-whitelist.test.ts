import { describe, expect, it } from "vitest";
import { toggleStyleWhitelistId } from "./style-whitelist";

describe("toggleStyleWhitelistId", () => {
  it("appends a newly-checked id at the end, regardless of catalog order", () => {
    // "atmospheric" sorts before "cinematic" in the STYLE_PRESETS catalog,
    // but here it's checked SECOND — the saved order must reflect that.
    const afterFirst = toggleStyleWhitelistId([], "cinematic", true);
    const afterSecond = toggleStyleWhitelistId(afterFirst, "atmospheric", true);
    expect(afterSecond).toEqual(["cinematic", "atmospheric"]);
  });

  it("unchecking removes only that id, preserving the order of the rest", () => {
    const list = ["cinematic", "atmospheric", "memory-film"];
    expect(toggleStyleWhitelistId(list, "atmospheric", false)).toEqual(["cinematic", "memory-film"]);
  });

  it("checking an already-present id is idempotent (no duplicate, no reorder)", () => {
    const list = ["cinematic", "atmospheric"];
    expect(toggleStyleWhitelistId(list, "cinematic", true)).toEqual(["cinematic", "atmospheric"]);
  });

  it("unchecking an id that isn't present is a no-op", () => {
    const list = ["cinematic"];
    expect(toggleStyleWhitelistId(list, "hype-reel", false)).toEqual(["cinematic"]);
  });

  it("returns a fresh array (never mutates the input)", () => {
    const list = ["cinematic"];
    const result = toggleStyleWhitelistId(list, "atmospheric", true);
    expect(result).not.toBe(list);
    expect(list).toEqual(["cinematic"]);
  });
});
