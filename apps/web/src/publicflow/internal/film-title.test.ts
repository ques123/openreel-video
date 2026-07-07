import { describe, expect, it } from "vitest";
import { buildFilmTitleFallback } from "./film-title";

describe("buildFilmTitleFallback", () => {
  it("uses the brief verbatim when it's within the word cap", () => {
    expect(buildFilmTitleFallback("our week in the mountains")).toBe("our week in the mountains");
  });

  it("truncates a long brief to the first 6 words with an ellipsis", () => {
    expect(buildFilmTitleFallback("a very long brief about our entire summer road trip across three countries")).toBe(
      "a very long brief about our…",
    );
  });

  it("trims surrounding whitespace before measuring words", () => {
    expect(buildFilmTitleFallback("   a quiet morning   ")).toBe("a quiet morning");
  });

  it("collapses internal run-on whitespace when splitting words", () => {
    expect(buildFilmTitleFallback("one   two\tthree")).toBe("one two three");
  });

  it("falls back to '<Style> Cut' when the brief is empty but a style label is given", () => {
    expect(buildFilmTitleFallback("", "Cinematic")).toBe("Cinematic Cut");
    expect(buildFilmTitleFallback("   ", "Memory film")).toBe("Memory film Cut");
  });

  it("falls back to 'Untitled Cut' when both brief and style are absent", () => {
    expect(buildFilmTitleFallback("")).toBe("Untitled Cut");
    expect(buildFilmTitleFallback("  ", null)).toBe("Untitled Cut");
  });

  it("never returns an empty string", () => {
    expect(buildFilmTitleFallback("").length).toBeGreaterThan(0);
  });
});
