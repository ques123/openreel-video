import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOUD_STT_MAX_CHUNK_S,
  planCloudSttUpload,
  remapChunkTimeToSourceS,
  remapCloudSttSegments,
  type CloudSttRegionMap,
} from "../cloud-stt-plan";
import { processVadRegions, type VadRegion } from "../vad-regions";
import type { TranscriptSegment } from "../types";

const SR = 16000;

function region(start: number, end: number): VadRegion {
  return { start, end };
}

/** Groq's (and OpenAI's) per-request billing floor, duplicated here as a one-liner rather than importing the web layer from core. */
const billed = (durationS: number) => Math.max(durationS, 10);

// ---------------------------------------------------------------------------
// planCloudSttUpload
// ---------------------------------------------------------------------------

describe("planCloudSttUpload", () => {
  it("zero-speech clip -> zero uploads", () => {
    const plan = planCloudSttUpload(600 * SR, SR, []);
    expect(plan.chunks).toEqual([]);
    expect(plan.totalSpeechS).toBe(0);
  });

  it("degenerates safely on an empty/invalid clip (zero pcm length)", () => {
    expect(planCloudSttUpload(0, SR, [region(0, 1)])).toEqual({ chunks: [], totalSpeechS: 0 });
  });

  it("packs a single short region into one chunk with exact sample offsets", () => {
    const plan = planCloudSttUpload(10 * SR, SR, [region(2, 5)]);
    expect(plan.chunks).toHaveLength(1);
    const chunk = plan.chunks[0];
    expect(chunk.durationS).toBeCloseTo(3);
    expect(chunk.sampleCount).toBe(3 * SR);
    expect(chunk.regions).toEqual([
      {
        srcStartS: 2,
        srcEndS: 5,
        srcStartSample: 2 * SR,
        srcEndSample: 5 * SR,
        chunkOffsetS: 0,
      },
    ]);
    expect(plan.totalSpeechS).toBeCloseTo(3);
  });

  it("packs multiple small regions that fit together into ONE chunk (the economics case)", () => {
    // 7 small regions, well under the 600s cap combined — must all land in
    // one chunk, not seven separate ones (see the "many tiny requests" note
    // in cloud-stt-plan.ts's module doc).
    const regions: VadRegion[] = [];
    for (let i = 0; i < 7; i += 1) regions.push(region(i * 80, i * 80 + 10));
    const plan = planCloudSttUpload(600 * SR, SR, regions);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].regions).toHaveLength(7);
    expect(plan.chunks[0].durationS).toBeCloseTo(70);
    // chunkOffsetS values are the running sum of prior regions' durations, in order.
    expect(plan.chunks[0].regions.map((r) => r.chunkOffsetS)).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("starts a new chunk when the next region would overflow maxChunkS", () => {
    const plan = planCloudSttUpload(2000 * SR, SR, [region(0, 590), region(600, 1190)], {
      maxChunkS: 600,
    });
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0].durationS).toBeCloseTo(590);
    expect(plan.chunks[0].regions).toHaveLength(1);
    expect(plan.chunks[1].durationS).toBeCloseTo(590);
    expect(plan.chunks[1].regions[0].chunkOffsetS).toBe(0); // fresh chunk, offset resets
  });

  it("fills a chunk as tightly as possible before overflowing (greedy pack, not one-region-per-chunk)", () => {
    // First two regions (100 + 100 = 200s) fit; the third (450s) would push
    // to 650 > 600, so it starts a new chunk instead of being merged in.
    const plan = planCloudSttUpload(2000 * SR, SR, [
      region(0, 100),
      region(150, 250),
      region(300, 750),
    ]);
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0].regions).toHaveLength(2);
    expect(plan.chunks[0].durationS).toBeCloseTo(200);
    expect(plan.chunks[1].regions).toHaveLength(1);
    expect(plan.chunks[1].durationS).toBeCloseTo(450);
  });

  it("splits a single region longer than maxChunkS into consecutive capped chunks (600s split)", () => {
    const plan = planCloudSttUpload(2000 * SR, SR, [region(0, 1350)], { maxChunkS: 600 });
    expect(plan.chunks.map((c) => c.durationS)).toEqual([600, 600, 150]);
    // Every chunk still starts its own region map at offset 0 (a fresh upload each).
    for (const c of plan.chunks) expect(c.regions[0].chunkOffsetS).toBe(0);
    expect(plan.totalSpeechS).toBeCloseTo(1350);
  });

  it("clamps regions outside [0, totalDurationS] rather than trusting the caller", () => {
    const plan = planCloudSttUpload(10 * SR, SR, [region(-5, 3), region(8, 999)]);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].regions).toEqual([
      { srcStartS: 0, srcEndS: 3, srcStartSample: 0, srcEndSample: 3 * SR, chunkOffsetS: 0 },
      { srcStartS: 8, srcEndS: 10, srcStartSample: 8 * SR, srcEndSample: 10 * SR, chunkOffsetS: 3 },
    ]);
  });

  it("drops zero-duration or inverted regions", () => {
    const plan = planCloudSttUpload(10 * SR, SR, [region(2, 2), region(5, 4), region(1, 3)]);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].regions).toHaveLength(1);
    expect(plan.chunks[0].regions[0]).toMatchObject({ srcStartS: 1, srcEndS: 3 });
  });

  it("sorts out-of-order input regions before packing", () => {
    const plan = planCloudSttUpload(10 * SR, SR, [region(6, 7), region(1, 2)]);
    expect(plan.chunks[0].regions.map((r) => r.srcStartS)).toEqual([1, 6]);
  });

  it("respects a custom maxChunkS", () => {
    const plan = planCloudSttUpload(100 * SR, SR, [region(0, 12), region(15, 27)], { maxChunkS: 20 });
    // 12 fits; 12+12=24 > 20, so the second region starts a fresh chunk.
    expect(plan.chunks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// remapChunkTimeToSourceS / remapCloudSttSegments
// ---------------------------------------------------------------------------

describe("remapChunkTimeToSourceS", () => {
  const regions: CloudSttRegionMap[] = [
    { srcStartS: 100, srcEndS: 110, srcStartSample: 100 * SR, srcEndSample: 110 * SR, chunkOffsetS: 0 },
    { srcStartS: 500, srcEndS: 503, srcStartSample: 500 * SR, srcEndSample: 503 * SR, chunkOffsetS: 10 },
  ];

  it("maps a point inside the first packed region", () => {
    expect(remapChunkTimeToSourceS(2, regions)).toBeCloseTo(102);
  });

  it("maps a point inside the second packed region (offset by the first region's packed length)", () => {
    expect(remapChunkTimeToSourceS(11, regions)).toBeCloseTo(501);
  });

  it("resolves the exact seam between two regions to the end of the earlier one (deterministic first-match)", () => {
    expect(remapChunkTimeToSourceS(10, regions)).toBeCloseTo(110);
  });

  it("clamps a point past the very end to the last region's end", () => {
    expect(remapChunkTimeToSourceS(999, regions)).toBeCloseTo(503);
  });

  it("clamps a point before the very start to the first region's start", () => {
    expect(remapChunkTimeToSourceS(-5, regions)).toBeCloseTo(100);
  });

  it("returns the input unchanged when there are no regions to map against", () => {
    expect(remapChunkTimeToSourceS(42, [])).toBe(42);
  });
});

describe("remapCloudSttSegments", () => {
  it("remaps t0/t1 of every segment, preserving text, across multiple packed regions", () => {
    const regions: CloudSttRegionMap[] = [
      { srcStartS: 0, srcEndS: 5, srcStartSample: 0, srcEndSample: 5 * SR, chunkOffsetS: 0 },
      { srcStartS: 300, srcEndS: 306, srcStartSample: 300 * SR, srcEndSample: 306 * SR, chunkOffsetS: 5 },
    ];
    const segments: TranscriptSegment[] = [
      { t0: 0.5, t1: 1.5, text: "hello" },
      { t0: 6, t1: 8, text: "world" },
    ];
    expect(remapCloudSttSegments(segments, regions)).toEqual([
      { t0: 0.5, t1: 1.5, text: "hello" },
      { t0: 301, t1: 303, text: "world" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(remapCloudSttSegments([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Economics: the gated path must never bill more than the ungated path.
// ---------------------------------------------------------------------------

describe("VAD-gate economics (gated billed seconds <= ungated billed seconds)", () => {
  /** The un-gated path's billing for a clip of `durationS`: fixed maxChunkS macro-chunks, each billed at the 10s floor. */
  function ungatedBilledSeconds(durationS: number, maxChunkS = DEFAULT_CLOUD_STT_MAX_CHUNK_S): number {
    let total = 0;
    for (let start = 0; start < durationS; start += maxChunkS) {
      total += billed(Math.min(maxChunkS, durationS - start));
    }
    return total || billed(0); // a zero-length clip still costs one (degenerate) request in practice; not exercised below
  }

  function gatedBilledSeconds(pcmLength: number, sampleRate: number, regions: VadRegion[]): number {
    const plan = planCloudSttUpload(pcmLength, sampleRate, regions);
    return plan.chunks.reduce((s, c) => s + billed(c.durationS), 0);
  }

  it("REQUIRED smoke test: 10-min clip, 90s of speech in 7 regions -> gated <= 120s vs 600s ungated", () => {
    const totalDurationS = 600; // 10 minutes
    const rawRegions: VadRegion[] = [];
    for (let i = 0; i < 7; i += 1) {
      // ~12.857s each, spaced 80s apart, well clear of each other and of the clip bounds.
      rawRegions.push(region(i * 80, i * 80 + 90 / 7));
    }
    const totalRawS = rawRegions.reduce((s, r) => s + (r.end - r.start), 0);
    expect(totalRawS).toBeCloseTo(90, 1);

    // Realistic usage: regions are already merged/padded by vad-regions.ts
    // before planCloudSttUpload ever sees them.
    const finalRegions = processVadRegions(rawRegions, { totalDurationS, maxRegionS: 600 });

    const pcmLength = totalDurationS * SR;
    const gated = gatedBilledSeconds(pcmLength, SR, finalRegions);
    const ungated = ungatedBilledSeconds(totalDurationS);

    expect(ungated).toBe(600);
    expect(gated).toBeLessThanOrEqual(120);
    expect(gated).toBeLessThan(ungated);
  });

  it("adversarial case: many scattered sub-10s blips still cost <= the ungated path (the exact failure mode packing exists to prevent)", () => {
    // 40 blips of 1s each, spread across a 20-minute clip: naive "one request
    // per region" billing would be 40 * 10s = 400s; packing must do far
    // better (the blips all fit in well under 600s of packed content).
    const totalDurationS = 1200; // 20 minutes
    const rawRegions: VadRegion[] = [];
    for (let i = 0; i < 40; i += 1) rawRegions.push(region(i * 25, i * 25 + 1));
    const finalRegions = processVadRegions(rawRegions, { totalDurationS, maxRegionS: 600 });

    const pcmLength = totalDurationS * SR;
    const gated = gatedBilledSeconds(pcmLength, SR, finalRegions);
    const ungated = ungatedBilledSeconds(totalDurationS);
    const naiveOneRequestPerRegion = finalRegions.length * 10;

    expect(gated).toBeLessThanOrEqual(ungated);
    expect(gated).toBeLessThan(naiveOneRequestPerRegion);
  });

  it("near-continuous speech (little to gate) costs about the same as ungated, never more", () => {
    const totalDurationS = 300;
    const finalRegions = processVadRegions([region(0, 295)], { totalDurationS, maxRegionS: 600 });
    const pcmLength = totalDurationS * SR;
    const gated = gatedBilledSeconds(pcmLength, SR, finalRegions);
    const ungated = ungatedBilledSeconds(totalDurationS);
    expect(gated).toBeLessThanOrEqual(ungated);
  });

  it("a long clip with speech spanning multiple 600s chunks still never exceeds ungated", () => {
    const totalDurationS = 3600; // 1 hour
    // Speech scattered across the whole hour in modest bursts.
    const rawRegions: VadRegion[] = [];
    for (let i = 0; i < 20; i += 1) rawRegions.push(region(i * 170, i * 170 + 20));
    const finalRegions = processVadRegions(rawRegions, { totalDurationS, maxRegionS: 600 });
    const pcmLength = totalDurationS * SR;
    const gated = gatedBilledSeconds(pcmLength, SR, finalRegions);
    const ungated = ungatedBilledSeconds(totalDurationS);
    expect(gated).toBeLessThanOrEqual(ungated);
  });
});
