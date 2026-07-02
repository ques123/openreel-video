import { describe, expect, it } from "vitest";
import { deserializeDossier, serializeDossier } from "../dossier-cache";
import type { ClipDossier } from "../types";

function makeDossier(): ClipDossier {
  return {
    version: 2,
    clipId: "clip-1",
    cacheKey: "perception:v1:test.mp4:123:456",
    fileName: "test.mp4",
    durationS: 12.5,
    analyzedThroughS: null,
    width: 1920,
    height: 1080,
    shots: [
      {
        index: 0,
        tStart: 0,
        tEnd: 6.2,
        repFrameTime: 3.1,
        thumbnailDataUrl: "data:image/jpeg;base64,abc123",
        embedding: new Float32Array([0.1, -0.5, 0.25, 1e-7]),
        frameEmbeddings: [
          new Float32Array([0.1, -0.5, 0.25, 1e-7]),
          new Float32Array([0.3, 0.1, -0.2, 0.9]),
        ],
        motion: { score: 4.2, peakTime: 3.1 },
        quality: { sharpness: 812.5 },
      },
      {
        index: 1,
        tStart: 6.2,
        tEnd: 12.5,
        repFrameTime: 8,
        thumbnailDataUrl: "data:image/jpeg;base64,def456",
        embedding: null, // embed pass failed for this shot
        frameEmbeddings: [],
        motion: { score: 0.8, peakTime: 7.5 },
        quality: { sharpness: 55 },
      },
    ],
    transcript: [{ t0: 0.5, t1: 4.2, text: "we finally made it to the falls" }],
    perf: {
      ingestMs: 800,
      usedOpfs: true,
      decodeMs: 1500,
      framesDecoded: 75,
      analysisFps: 50,
      realtimeFactor: 8.3,
      embedMs: 400,
      embedPerFrameMs: 200,
      audioDecodeMs: 300,
      whisperMs: 2100,
      whisperRealtimeFactor: 5.9,
      modelLoadMs: { clip: 4000, whisper: 6000 },
      totalMs: 9000,
      device: { embed: "webgpu", whisper: "webgpu" },
      cacheHit: false,
    },
  };
}

describe("dossier serialization", () => {
  it("round-trips a dossier exactly, including Float32Array embeddings", () => {
    const original = makeDossier();
    const restored = deserializeDossier(serializeDossier(original));

    expect(restored.fileName).toBe(original.fileName);
    expect(restored.transcript).toEqual(original.transcript);
    expect(restored.perf).toEqual(original.perf);
    expect(restored.shots).toHaveLength(2);

    const emb = restored.shots[0].embedding;
    expect(emb).toBeInstanceOf(Float32Array);
    expect(Array.from(emb!)).toEqual(Array.from(original.shots[0].embedding!));
    expect(restored.shots[1].embedding).toBeNull();
    expect(restored.shots[0].motion).toEqual(original.shots[0].motion);
  });

  it("produces a standalone ArrayBuffer", () => {
    const buffer = serializeDossier(makeDossier());
    expect(buffer.byteLength).toBeGreaterThan(0);
    // Decoding from the raw buffer must work (no offset issues).
    expect(() => deserializeDossier(buffer)).not.toThrow();
  });
});
