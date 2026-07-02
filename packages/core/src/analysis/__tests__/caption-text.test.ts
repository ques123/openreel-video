import { describe, expect, it } from "vitest";
import { cleanCaption, mergeDenseCaptions } from "../caption-text";

describe("cleanCaption", () => {
  it("strips Florence's boilerplate framing", () => {
    expect(cleanCaption("In this image we can see the wall.")).toBe("the wall");
    expect(
      cleanCaption(
        "In this image I can see a person standing. In this image we can also see trees and sky.",
      ),
    ).toBe("a person standing; trees and sky");
  });

  it("leaves plain captions alone", () => {
    expect(cleanCaption("a red car on a bridge")).toBe("a red car on a bridge");
  });
});

describe("mergeDenseCaptions", () => {
  it("merges runs of similar captions into time ranges", () => {
    const segs = mergeDenseCaptions([
      { t: 0, text: "road, trees and sky" },
      { t: 2, text: "road, trees and sky" },
      { t: 4, text: "the road, trees and the sky" },
      { t: 6, text: "a person standing at a market" },
      { t: 8, text: "road, trees and sky" },
    ]);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ t0: 0, t1: 4, text: "road, trees and sky" });
    expect(segs[1]).toMatchObject({ t0: 6, t1: 6 });
    expect(segs[2]).toMatchObject({ t0: 8, t1: 8 });
  });

  it("sorts by time and handles empty input", () => {
    expect(mergeDenseCaptions([])).toEqual([]);
    const segs = mergeDenseCaptions([
      { t: 4, text: "b" },
      { t: 0, text: "a" },
    ]);
    expect(segs[0].t0).toBe(0);
  });
});
