import { describe, expect, it } from "vitest";
import { deserializeDossier, serializeDossier } from "../dossier-cache";
import type { ClipDossier } from "../types";

function makeDossier(): ClipDossier {
  return {
    version: 4,
    clipId: "clip-1",
    cacheKey: "perception:v4:test.mp4:123:456",
    fileName: "test.mp4",
    recordedAt: 456,
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
        caption: "a man walks through a market",
        cloudCaption: "a man browses durian stalls in a covered market, warm light",
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
        caption: null,
        cloudCaption: null,
        quality: { sharpness: 55 },
      },
    ],
    denseFrames: [{ t: 2, dataUrl: "data:image/jpeg;base64,frame2" }],
    denseCaptions: [{ t: 2, text: "a market street" }],
    cloudDenseCaptions: [{ t: 2, text: "a bustling market street at dusk" }],
    cloudShotCaptions: [{ t: 3.1, text: "vendor mid-slice, knife raised" }],
    cloudRuns: {
      shots: {
        model: "gpt-5.2",
        enhancedAt: 1234000,
        framesSent: 1,
        framesFailed: 0,
        ms: 900,
        promptTokens: 500,
        completionTokens: 60,
      },
      timeline: null,
    },
    cloudVision: { model: "gpt-5.2", scope: "timeline", enhancedAt: 1234567 },
    localCaptionPerf: { totalMs: 4200, frames: 3 },
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

describe("legacy migration (pre-split cloud stores)", () => {
  it("derives cloudShotCaptions and cloudRuns from a shots-scope legacy record", () => {
    const legacy = makeDossier() as unknown as Record<string, unknown>;
    delete legacy.cloudShotCaptions;
    delete legacy.cloudRuns;
    delete legacy.localCaptionPerf;
    legacy.cloudDenseCaptions = [];
    legacy.cloudVision = { model: "gpt-5.2", scope: "shots", enhancedAt: 42 };
    const buf = new TextEncoder().encode(JSON.stringify(serializeForTest(legacy)));
    const restored = deserializeDossier(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    // shot 0 had a cloudCaption -> becomes the shots-scope store at its rep time
    expect(restored.cloudShotCaptions).toEqual([
      { t: 3.1, text: "a man browses durian stalls in a covered market, warm light" },
    ]);
    expect(restored.cloudRuns.shots).toMatchObject({ model: "gpt-5.2", framesSent: 1 });
    expect(restored.cloudRuns.timeline).toBeNull();
    expect(restored.localCaptionPerf).toBeNull();
  });
});

/** JSON-serialize embeddings the way serializeDossier does, for hand-built legacy records. */
function serializeForTest(d: Record<string, unknown>): Record<string, unknown> {
  const shots = (d.shots as Record<string, unknown>[]).map((shot) => {
    const { embedding, frameEmbeddings, ...rest } = shot;
    void embedding;
    void frameEmbeddings;
    return { ...rest, embeddingB64: null, frameEmbeddingsB64: [] };
  });
  return { ...d, shots };
}
