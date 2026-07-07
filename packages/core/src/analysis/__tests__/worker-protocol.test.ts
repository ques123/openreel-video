import { describe, expect, it } from "vitest";
import { WHISPER_MODEL_IDS } from "../worker-protocol";

// worker-protocol.ts has no worker-only runtime imports (everything else it
// imports is `import type`), so this constant is safe to exercise directly
// under vitest/jsdom — unlike whisper-worker.ts itself, which needs a real
// browser (see whisper-worker's module doc / this repo's testing convention).

describe("WHISPER_MODEL_IDS", () => {
  it("maps 'base' to the small whisper checkpoint", () => {
    expect(WHISPER_MODEL_IDS.base).toBe("onnx-community/whisper-base");
  });

  it("maps 'large-v3-turbo' to the large whisper checkpoint", () => {
    expect(WHISPER_MODEL_IDS["large-v3-turbo"]).toBe("onnx-community/whisper-large-v3-turbo");
  });

  it("has exactly the two selectable models", () => {
    expect(Object.keys(WHISPER_MODEL_IDS).sort()).toEqual(["base", "large-v3-turbo"]);
  });

  it("maps every model id to a distinct, non-empty repo id", () => {
    const ids = Object.values(WHISPER_MODEL_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
