import { describe, expect, it } from "vitest";
import { cleanCaption, mergeDenseCaptions, similarCaptions } from "../caption-text";

describe("cleanCaption", () => {
  it("strips Florence's boilerplate framing", () => {
    expect(cleanCaption("In this image we can see the wall.")).toBe("the wall");
    expect(
      cleanCaption(
        "In this image I can see a person standing. In this image we can also see trees and sky.",
      ),
    ).toBe("a person standing; trees and sky");
  });

  it("strips FastVLM's boilerplate framing", () => {
    expect(
      cleanCaption(
        "The image depicts a bustling outdoor market scene where a vendor is selling durian fruits.",
      ),
    ).toBe("a bustling outdoor market scene where a vendor is selling durian fruits");
    expect(cleanCaption("The frame shows a person's hand holding a document.")).toBe(
      "a person's hand holding a document",
    );
    // Only the LEADING boilerplate goes; later sentences keep their prose.
    expect(
      cleanCaption("The image captures a calm lobby. The mood is elegant and formal."),
    ).toBe("a calm lobby. The mood is elegant and formal");
  });

  it("drops a trailing sentence fragment from token-capped generations", () => {
    expect(
      cleanCaption(
        "The image depicts a calm scene. The image is well-composed, with the main subject (",
      ),
    ).toBe("a calm scene");
    // A caption that is ALL fragment (no complete sentence) stays intact.
    expect(cleanCaption("a person waiting at a carousel")).toBe(
      "a person waiting at a carousel",
    );
  });

  it("leaves plain captions alone", () => {
    expect(cleanCaption("a red car on a bridge")).toBe("a red car on a bridge");
    expect(cleanCaption("A man in a grey shirt grimaces as rain soaks the stalls.")).toBe(
      "A man in a grey shirt grimaces as rain soaks the stalls",
    );
  });
});

describe("similarCaptions", () => {
  // Also the transcript hallucination-collapse primitive (signal-score.ts):
  // whisper loops repeat the same phrase with tiny punctuation variations.
  it("matches identical and punctuation-variant texts", () => {
    expect(similarCaptions("thanks for watching", "thanks for watching")).toBe(true);
    expect(similarCaptions("Thanks for watching.", "Thanks for watching!")).toBe(true);
  });

  it("matches high word-overlap variations", () => {
    expect(similarCaptions("road, trees and sky", "the road, trees and the sky")).toBe(true);
  });

  it("rejects genuinely different texts", () => {
    expect(similarCaptions("thanks for watching", "the boats are heading out now")).toBe(false);
    expect(similarCaptions("we reached the summit", "look at that view down there")).toBe(false);
  });

  it("never matches empty word sets against non-empty text", () => {
    expect(similarCaptions("...", "thanks for watching")).toBe(false);
    expect(similarCaptions("", "")).toBe(true); // exact-equality fast path
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
