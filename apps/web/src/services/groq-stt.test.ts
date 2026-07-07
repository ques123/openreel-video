/**
 * groq-stt: pure helpers get direct unit tests (chunk boundary math,
 * 10s-minimum billing math, Groq-wire-to-core offset remapping, the
 * hand-rolled WAV encoder, multipart field assembly); the network layer gets
 * tests against a mocked fetch. WebCodecs doesn't exist under vitest/jsdom,
 * so every transcribeCloudPcm call here exercises the (equally real) WAV
 * fallback path — see encodeChunkAudio's feature check in groq-stt.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { VadRegion } from "@openreel/core";
import {
  billedSecondsForChunk,
  buildGroqFormFields,
  CLOUD_CHUNK_S,
  computeChunkBounds,
  costUSDForBilledSeconds,
  encodeWavBlob,
  encodeWavBytes,
  GROQ_MIN_BILLED_SECONDS,
  GROQ_WHISPER_MODEL,
  GROQ_WHISPER_USD_PER_HOUR,
  toTranscriptSegments,
  toTranscriptWords,
  transcribeCloudPcm,
  transcribeCloudPcmGated,
} from "./groq-stt";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Pure helpers: chunk boundary math
// ---------------------------------------------------------------------------

describe("computeChunkBounds", () => {
  it("returns no chunks for empty audio", () => {
    expect(computeChunkBounds(0, 16000)).toEqual([]);
  });

  it("returns one chunk when audio is shorter than the chunk length", () => {
    expect(computeChunkBounds(8000, 16000, 600)).toEqual([
      { startSample: 0, endSample: 8000, startS: 0, endS: 0.5 },
    ]);
  });

  it("splits exactly on the boundary with no trailing empty chunk", () => {
    const bounds = computeChunkBounds(20, 10, 1); // chunkSamples = 10
    expect(bounds).toEqual([
      { startSample: 0, endSample: 10, startS: 0, endS: 1 },
      { startSample: 10, endSample: 20, startS: 1, endS: 2 },
    ]);
  });

  it("leaves a shorter final chunk for a non-exact remainder", () => {
    const bounds = computeChunkBounds(25, 10, 1); // chunkSamples = 10
    expect(bounds).toEqual([
      { startSample: 0, endSample: 10, startS: 0, endS: 1 },
      { startSample: 10, endSample: 20, startS: 1, endS: 2 },
      { startSample: 20, endSample: 25, startS: 2, endS: 2.5 },
    ]);
  });

  it("defaults to the CLOUD_CHUNK_S (600s) macro-chunk length", () => {
    const totalSamples = CLOUD_CHUNK_S * 16000 + 1;
    const bounds = computeChunkBounds(totalSamples, 16000);
    expect(bounds).toHaveLength(2);
    expect(bounds[0]).toEqual({ startSample: 0, endSample: 9_600_000, startS: 0, endS: 600 });
    expect(bounds[1].startSample).toBe(9_600_000);
    expect(bounds[1].endSample).toBe(totalSamples);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: cost accounting
// ---------------------------------------------------------------------------

describe("billedSecondsForChunk", () => {
  it("clamps chunks shorter than the 10s minimum up to 10", () => {
    expect(billedSecondsForChunk(0)).toBe(GROQ_MIN_BILLED_SECONDS);
    expect(billedSecondsForChunk(3)).toBe(10);
    expect(billedSecondsForChunk(9.99)).toBe(10);
  });

  it("passes through chunks at or above the minimum unchanged", () => {
    expect(billedSecondsForChunk(10)).toBe(10);
    expect(billedSecondsForChunk(600)).toBe(600);
  });
});

describe("costUSDForBilledSeconds", () => {
  it("prices a full hour at the list rate", () => {
    expect(costUSDForBilledSeconds(3600)).toBeCloseTo(GROQ_WHISPER_USD_PER_HOUR);
  });

  it("scales linearly for partial hours", () => {
    expect(costUSDForBilledSeconds(36)).toBeCloseTo(0.0004);
    expect(costUSDForBilledSeconds(610)).toBeCloseTo((610 / 3600) * 0.04);
  });

  it("accepts a custom rate override", () => {
    expect(costUSDForBilledSeconds(3600, 1)).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: Groq wire shape -> core TranscriptSegment / word offsetting
// ---------------------------------------------------------------------------

describe("toTranscriptSegments", () => {
  it("maps start/end/text and offsets into clip-absolute seconds", () => {
    expect(
      toTranscriptSegments([{ start: 1, end: 2.5, text: "hello" }], 600),
    ).toEqual([{ t0: 601, t1: 602.5, text: "hello" }]);
  });

  it("drops blank/whitespace-only segments", () => {
    expect(
      toTranscriptSegments(
        [
          { start: 0, end: 1, text: "  " },
          { start: 1, end: 2, text: "" },
          { start: 2, end: 3, text: " ok " },
        ],
        0,
      ),
    ).toEqual([{ t0: 2, t1: 3, text: "ok" }]);
  });

  it("treats an undefined segments array as empty", () => {
    expect(toTranscriptSegments(undefined, 0)).toEqual([]);
  });
});

describe("toTranscriptWords", () => {
  it("returns null for an absent/null words field (chunk lacked word data)", () => {
    expect(toTranscriptWords(undefined, 0)).toBeNull();
    expect(toTranscriptWords(null, 0)).toBeNull();
  });

  it("returns an empty array (not null) for a present-but-empty words field", () => {
    expect(toTranscriptWords([], 0)).toEqual([]);
  });

  it("maps word/start/end and offsets into clip-absolute seconds", () => {
    expect(
      toTranscriptWords([{ word: "hi", start: 0.2, end: 0.4 }], 600),
    ).toEqual([{ word: "hi", startS: 600.2, endS: 600.4 }]);
  });
});

// ---------------------------------------------------------------------------
// Pure helper: WAV encoder bytes
// ---------------------------------------------------------------------------

describe("encodeWavBytes", () => {
  it("writes a correct RIFF/WAVE/fmt/data header for 16kHz mono", () => {
    const bytes = encodeWavBytes(new Float32Array([0, 1]), 16000);
    const view = new DataView(bytes.buffer);
    const ascii = (start: number, len: number) =>
      String.fromCharCode(...bytes.subarray(start, start + len));

    expect(bytes.length).toBe(44 + 4); // header + 2 samples * 2 bytes
    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 4); // riff chunk size
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(32000); // byte rate = rate * channels * bytesPerSample
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4); // data size
  });

  it("quantizes samples to int16 and clamps out-of-range values", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    const bytes = encodeWavBytes(samples, 16000);
    const view = new DataView(bytes.buffer);

    const decoded = Array.from({ length: samples.length }, (_, i) =>
      view.getInt16(44 + i * 2, true),
    );
    expect(decoded).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
  });

  it("scales data size and total length with sample count", () => {
    const bytes = encodeWavBytes(new Float32Array(1000), 16000);
    expect(bytes.length).toBe(44 + 2000);
  });
});

describe("encodeWavBlob", () => {
  it("wraps the encoded bytes in an audio/wav Blob of the right size", () => {
    // jsdom's Blob has no arrayBuffer()/text() to read bytes back — byte
    // content is already verified exhaustively by the encodeWavBytes tests
    // above; this just checks the Blob wrapping itself (mime type + size).
    const blob = encodeWavBlob(new Float32Array([0, 1]), 16000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// Pure helper: multipart field assembly
// ---------------------------------------------------------------------------

describe("buildGroqFormFields", () => {
  it("always includes model, response_format, and both timestamp granularities", () => {
    expect(buildGroqFormFields()).toEqual([
      ["model", "whisper-large-v3-turbo"],
      ["response_format", "verbose_json"],
      ["timestamp_granularities[]", "segment"],
      ["timestamp_granularities[]", "word"],
    ]);
  });

  it("appends language only when provided", () => {
    const fields = buildGroqFormFields("en");
    expect(fields).toHaveLength(5);
    expect(fields[4]).toEqual(["language", "en"]);
  });
});

// ---------------------------------------------------------------------------
// Network layer: transcribeCloudPcm against a mocked fetch
// ---------------------------------------------------------------------------

interface SentRequest {
  url: string;
  method?: string;
  form: FormData;
  signal: AbortSignal | null | undefined;
}

interface MockResponse {
  status: number;
  contentType: string;
  json?: unknown;
  text?: string;
}

/** fetch stub: records every request (URL, method, parsed FormData, signal) and answers per-call via `respond`. */
function stubFetch(respond: (call: number, sent: SentRequest) => MockResponse) {
  const sent: SentRequest[] = [];
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: unknown; signal?: AbortSignal | null }) => {
      const record: SentRequest = {
        url,
        method: init.method,
        form: init.body as FormData,
        signal: init.signal,
      };
      sent.push(record);
      const r = respond(call, record);
      call += 1;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? r.contentType : null) },
        json: async () => r.json,
        text: async () => r.text ?? "",
      };
    }),
  );
  return sent;
}

const okJson = (
  segments: { start: number; end: number; text: string }[],
  words: { word: string; start: number; end: number }[] | null = null,
): MockResponse => ({
  status: 200,
  contentType: "application/json",
  json: { segments, words },
});

describe("transcribeCloudPcm — request shape", () => {
  it("posts the documented multipart shape to the proxy path", async () => {
    const sent = stubFetch(() => okJson([{ start: 0, end: 1, text: "hi" }]));
    await transcribeCloudPcm(new Float32Array(16000), { language: "en" });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/proxy/groq/audio/transcriptions");
    expect(sent[0].method).toBe("POST");

    const { form } = sent[0];
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]);
    expect(form.get("language")).toBe("en");

    // AudioEncoder doesn't exist under jsdom, so this exercises the (equally
    // real) WAV fallback filename/mime.
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe("chunk.wav");
    expect(file.type).toBe("audio/wav");
  });

  it("omits the language field when not provided", async () => {
    const sent = stubFetch(() => okJson([]));
    await transcribeCloudPcm(new Float32Array(16000));
    expect(sent[0].form.get("language")).toBeNull();
  });
});

describe("transcribeCloudPcm — chunking, offsets, and billing", () => {
  it("returns an empty result with no network calls for empty audio", async () => {
    const sent = stubFetch(() => okJson([]));
    const result = await transcribeCloudPcm(new Float32Array(0));

    expect(sent).toHaveLength(0);
    expect(result.segments).toEqual([]);
    expect(result.words).toBeNull();
    expect(result.billedSeconds).toBe(0);
    expect(result.costUSD).toBe(0);
    expect(result.model).toBe(GROQ_WHISPER_MODEL);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("uploads sequential 600s chunks, offsets each chunk's segments/words, and sums billed seconds with the 10s floor", async () => {
    const progressCalls: [number, number][] = [];
    const sent = stubFetch((call) =>
      call === 0
        ? okJson([{ start: 1, end: 2, text: "hello" }], [{ word: "hello", start: 1, end: 1.5 }])
        : okJson([{ start: 0.5, end: 1.5, text: "world" }], [{ word: "world", start: 0.5, end: 1 }]),
    );

    // 600s (a full macro-chunk) + a short 3s tail chunk, below the billing floor.
    const totalSamples = (CLOUD_CHUNK_S + 3) * 16000;
    const pcm = new Float32Array(totalSamples);
    const result = await transcribeCloudPcm(pcm, {
      onProgress: (doneS, totalS) => progressCalls.push([doneS, totalS]),
    });

    expect(sent).toHaveLength(2);
    expect(result.segments).toEqual([
      { t0: 1, t1: 2, text: "hello" },
      { t0: 600.5, t1: 601.5, text: "world" },
    ]);
    expect(result.words).toEqual([
      { word: "hello", startS: 1, endS: 1.5 },
      { word: "world", startS: 600.5, endS: 601 },
    ]);

    // chunk 1 = 600s (already above the floor); chunk 2 = 3s (clamped to 10s).
    expect(result.billedSeconds).toBe(610);
    expect(result.costUSD).toBeCloseTo((610 / 3600) * 0.04);
    expect(result.model).toBe(GROQ_WHISPER_MODEL);

    expect(progressCalls).toEqual([
      [600, 603],
      [603, 603],
    ]);
  });

  it("collapses words to null only when EVERY chunk's response omitted them", async () => {
    const sent = stubFetch((call) =>
      call === 0
        ? okJson([{ start: 0, end: 1, text: "a" }], null)
        : okJson([{ start: 0, end: 1, text: "b" }], [{ word: "b", start: 0, end: 1 }]),
    );
    const totalSamples = (CLOUD_CHUNK_S + 1) * 16000;
    const result = await transcribeCloudPcm(new Float32Array(totalSamples));

    expect(sent).toHaveLength(2);
    // Chunk 2's words (offset by 600s) are kept even though chunk 1 had none.
    expect(result.words).toEqual([{ word: "b", startS: 600, endS: 601 }]);
  });
});

describe("transcribeCloudPcm — error mapping and retry", () => {
  it("retries once on a failed chunk and returns the successful retry's result", async () => {
    const sent = stubFetch((call) =>
      call === 0
        ? { status: 500, contentType: "application/json", text: "boom" }
        : okJson([{ start: 0, end: 1, text: "hi" }]),
    );
    const result = await transcribeCloudPcm(new Float32Array(16000));
    expect(sent).toHaveLength(2);
    expect(result.segments).toEqual([{ t0: 0, t1: 1, text: "hi" }]);
  });

  it("maps a non-JSON/HTML response to the apply-groq-proxy.sh guidance, retrying once before throwing", async () => {
    const sent = stubFetch(() => ({
      status: 200,
      contentType: "text/html",
      text: "<html>not proxied</html>",
    }));
    await expect(transcribeCloudPcm(new Float32Array(16000))).rejects.toThrow(
      /apply-groq-proxy\.sh/,
    );
    expect(sent).toHaveLength(2);
  });

  it("maps a 404 to the same apply-groq-proxy.sh guidance", async () => {
    const sent = stubFetch(() => ({ status: 404, contentType: "application/json", text: "" }));
    await expect(transcribeCloudPcm(new Float32Array(16000))).rejects.toThrow(
      /apply-groq-proxy\.sh/,
    );
    expect(sent).toHaveLength(2);
  });

  it("maps a 405 (nginx SPA fallback rejecting POST) to the apply-groq-proxy.sh guidance", async () => {
    const sent = stubFetch(() => ({
      status: 405,
      contentType: "text/html",
      text: "<html><head><title>405 Not Allowed</title></head></html>",
    }));
    await expect(transcribeCloudPcm(new Float32Array(16000))).rejects.toThrow(
      /apply-groq-proxy\.sh/,
    );
    expect(sent).toHaveLength(2);
  });

  it("maps any other HTML-bodied error status to the route guidance, not raw markup", async () => {
    stubFetch(() => ({
      status: 502,
      contentType: "text/html",
      text: "<html><body><center><h1>502 Bad Gateway</h1></center></body></html>",
    }));
    await expect(transcribeCloudPcm(new Float32Array(16000))).rejects.toThrow(
      /apply-groq-proxy\.sh/,
    );
  });

  it("maps 401/403 to server-side key guidance", async () => {
    const sent401 = stubFetch(() => ({ status: 401, contentType: "application/json", text: "" }));
    await expect(transcribeCloudPcm(new Float32Array(16000))).rejects.toThrow(
      /key missing or invalid on the server/,
    );
    expect(sent401).toHaveLength(2);

    const sent403 = stubFetch(() => ({ status: 403, contentType: "application/json", text: "" }));
    await expect(transcribeCloudPcm(new Float32Array(16000))).rejects.toThrow(
      /server-side config/,
    );
    expect(sent403).toHaveLength(2);
  });

  it("throws once a chunk has failed twice (no partial transcript returned)", async () => {
    stubFetch(() => ({ status: 500, contentType: "application/json", text: "still broken" }));
    await expect(transcribeCloudPcm(new Float32Array(16000))).rejects.toThrow(/Groq 500/);
  });
});

describe("transcribeCloudPcm — abort", () => {
  it("honors an already-aborted signal without making any request", async () => {
    const sent = stubFetch(() => okJson([]));
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribeCloudPcm(new Float32Array(16000), { signal: controller.signal }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("passes the caller's signal straight through to fetch for the in-flight request", async () => {
    const sent = stubFetch(() => okJson([{ start: 0, end: 1, text: "hi" }]));
    const controller = new AbortController();
    await transcribeCloudPcm(new Float32Array(16000), { signal: controller.signal });
    expect(sent[0].signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// Network layer: transcribeCloudPcmGated (VAD-gated upload path) against a
// mocked fetch. Packing/economics themselves are covered exhaustively in
// packages/core/src/analysis/__tests__/cloud-stt-plan.test.ts — these tests
// are about THIS file's own wiring: concatenating packed PCM, reusing the
// same network/retry/error path as transcribeCloudPcm, and remapping
// chunk-relative results back to absolute clip time.
// ---------------------------------------------------------------------------

describe("transcribeCloudPcmGated — zero-speech clip", () => {
  it("makes no network calls and returns an empty result when there are no VAD regions", async () => {
    const sent = stubFetch(() => okJson([]));
    const result = await transcribeCloudPcmGated(new Float32Array(100 * 16000), []);

    expect(sent).toHaveLength(0);
    expect(result).toEqual({
      segments: [],
      words: null,
      billedSeconds: 0,
      costUSD: 0,
      model: GROQ_WHISPER_MODEL,
      ms: expect.any(Number),
    });
  });
});

describe("transcribeCloudPcmGated — packing, concatenation, and remap", () => {
  it("packs disjoint regions into ONE upload and remaps chunk-relative segments/words back to absolute clip time", async () => {
    const progressCalls: [number, number][] = [];
    const sent = stubFetch(() =>
      okJson(
        [
          { start: 0, end: 1, text: "a" },
          { start: 6, end: 7, text: "b" },
        ],
        [
          { word: "a", start: 0, end: 1 },
          { word: "b", start: 6, end: 6.5 },
        ],
      ),
    );

    const pcm = new Float32Array(100 * 16000); // 100s clip
    const regions: VadRegion[] = [
      { start: 10, end: 15 }, // 5s
      { start: 50, end: 53 }, // 3s
    ];
    const result = await transcribeCloudPcmGated(pcm, regions, {
      onProgress: (doneS, totalS) => progressCalls.push([doneS, totalS]),
    });

    // Both regions (8s total) fit comfortably under the 600s cap -> one upload.
    expect(sent).toHaveLength(1);
    const uploaded = sent[0].form.get("file") as File;
    // 8s of packed audio at 16kHz mono 16-bit WAV = 44-byte header + 8*16000*2 bytes.
    expect(uploaded.size).toBe(44 + 8 * 16000 * 2);

    // "a" (chunk-time [0,1]) falls in the first packed region (chunkOffsetS 0..5) -> absolute [10,11].
    // "b" (chunk-time [6,7]) falls in the second packed region (chunkOffsetS 5..8) -> absolute [51,52].
    expect(result.segments).toEqual([
      { t0: 10, t1: 11, text: "a" },
      { t0: 51, t1: 52, text: "b" },
    ]);
    expect(result.words).toEqual([
      { word: "a", startS: 10, endS: 11 },
      { word: "b", startS: 51, endS: 51.5 },
    ]);

    // 8s of packed content is under the 10s floor.
    expect(result.billedSeconds).toBe(10);
    expect(result.costUSD).toBeCloseTo((10 / 3600) * 0.04);
    expect(progressCalls).toEqual([[8, 8]]);
  });

  it("uploads one request per packed chunk when regions don't all fit under the cap, summing billed seconds", async () => {
    const sent = stubFetch((call) =>
      call === 0
        ? okJson([{ start: 0, end: 590, text: "first chunk" }])
        : okJson([{ start: 0, end: 15, text: "second chunk" }]),
    );

    const pcm = new Float32Array(2000 * 16000);
    // 590 + 15 = 605 > the 600s cap, so packing must start a fresh chunk for
    // the second region rather than force both into one oversized upload.
    const regions: VadRegion[] = [
      { start: 0, end: 590 },
      { start: 700, end: 715 },
    ];
    const result = await transcribeCloudPcmGated(pcm, regions);

    expect(sent).toHaveLength(2);
    expect(result.segments).toEqual([
      { t0: 0, t1: 590, text: "first chunk" },
      { t0: 700, t1: 715, text: "second chunk" },
    ]);
    // chunk 1 = 590s + chunk 2 = 15s, both already above the 10s floor.
    expect(result.billedSeconds).toBe(605);
  });

  it("collapses words to null only when every chunk's response omitted them, mirroring transcribeCloudPcm", async () => {
    const sent = stubFetch((call) =>
      call === 0
        ? okJson([{ start: 0, end: 1, text: "a" }], null)
        : okJson([{ start: 0, end: 1, text: "b" }], [{ word: "b", start: 0, end: 1 }]),
    );
    const pcm = new Float32Array(2000 * 16000);
    const regions: VadRegion[] = [
      { start: 0, end: 590 },
      { start: 700, end: 715 },
    ];
    const result = await transcribeCloudPcmGated(pcm, regions);
    expect(sent).toHaveLength(2);
    expect(result.words).toEqual([{ word: "b", startS: 700, endS: 701 }]);
  });
});

describe("transcribeCloudPcmGated — reuses the un-gated path's network/error handling", () => {
  it("retries once on a failed chunk (same convention as transcribeCloudPcm)", async () => {
    const sent = stubFetch((call) =>
      call === 0
        ? { status: 500, contentType: "application/json", text: "boom" }
        : okJson([{ start: 0, end: 1, text: "hi" }]),
    );
    const result = await transcribeCloudPcmGated(new Float32Array(100 * 16000), [{ start: 0, end: 1 }]);
    expect(sent).toHaveLength(2);
    expect(result.segments).toEqual([{ t0: 0, t1: 1, text: "hi" }]);
  });

  it("maps a non-JSON/HTML response to the same apply-groq-proxy.sh guidance", async () => {
    stubFetch(() => ({ status: 200, contentType: "text/html", text: "<html>not proxied</html>" }));
    await expect(
      transcribeCloudPcmGated(new Float32Array(100 * 16000), [{ start: 0, end: 1 }]),
    ).rejects.toThrow(/apply-groq-proxy\.sh/);
  });
});

describe("transcribeCloudPcmGated — abort", () => {
  it("honors an already-aborted signal without making any request", async () => {
    const sent = stubFetch(() => okJson([]));
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribeCloudPcmGated(new Float32Array(100 * 16000), [{ start: 0, end: 1 }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});
