import { describe, expect, it } from "vitest";
import {
  detectBoundaries,
  dot,
  hsvHistogram,
  histDistance,
  l2Normalize,
  laplacianVariance,
  lumaDiff,
  summarizeShots,
  toGrayscale,
  type FrameSample,
} from "../shot-metrics";

/** Build a solid-color RGBA frame. */
function solidFrame(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  return rgba;
}

/** Checkerboard grayscale-ish frame (high-frequency detail). */
function checkerFrame(w: number, h: number, cell = 2): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 255 : 0;
      const i = (y * w + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const W = 32;
const H = 18;

describe("hsvHistogram", () => {
  it("is L1-normalized", () => {
    const hist = hsvHistogram(solidFrame(W, H, 200, 30, 30), W, H);
    const sum = hist.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("identical frames have zero distance", () => {
    const a = hsvHistogram(solidFrame(W, H, 200, 30, 30), W, H);
    const b = hsvHistogram(solidFrame(W, H, 200, 30, 30), W, H);
    expect(histDistance(a, b)).toBe(0);
  });

  it("different-colored frames have large distance", () => {
    const red = hsvHistogram(solidFrame(W, H, 220, 20, 20), W, H);
    const blue = hsvHistogram(solidFrame(W, H, 20, 20, 220), W, H);
    expect(histDistance(red, blue)).toBeGreaterThan(1.5);
  });
});

describe("grayscale + motion + sharpness", () => {
  it("lumaDiff is 0 for identical frames and large for opposite frames", () => {
    const dark = toGrayscale(solidFrame(W, H, 0, 0, 0), W, H);
    const light = toGrayscale(solidFrame(W, H, 255, 255, 255), W, H);
    expect(lumaDiff(dark, dark)).toBe(0);
    expect(lumaDiff(dark, light)).toBeGreaterThan(200);
  });

  it("laplacianVariance ranks checkerboard sharper than solid", () => {
    const flat = laplacianVariance(toGrayscale(solidFrame(W, H, 128, 128, 128), W, H), W, H);
    const sharp = laplacianVariance(toGrayscale(checkerFrame(W, H), W, H), W, H);
    expect(flat).toBe(0);
    expect(sharp).toBeGreaterThan(1000);
  });
});

function samplesFromDists(dists: number[], fps = 6): FrameSample[] {
  return dists.map((d, i) => ({
    t: i / fps,
    histDist: d,
    motionDiff: 1,
    sharpness: 100,
  }));
}

describe("detectBoundaries", () => {
  const opts = { absFloor: 0.35, k: 3, window: 24, minShotLengthS: 1.0 };

  it("finds a single clear cut", () => {
    // 30 quiet samples, a spike, 30 more quiet samples.
    const dists = [...Array(30).fill(0.05), 1.2, ...Array(30).fill(0.05)];
    const boundaries = detectBoundaries(samplesFromDists(dists), opts);
    expect(boundaries).toEqual([30]);
  });

  it("returns no boundaries for a single continuous shot", () => {
    const dists = Array(120).fill(0.08);
    expect(detectBoundaries(samplesFromDists(dists), opts)).toEqual([]);
  });

  it("enforces minimum shot length", () => {
    // Two spikes 3 samples apart (0.5s at 6fps) — second must be suppressed.
    const dists = [...Array(30).fill(0.05), 1.2, 0.05, 0.05, 1.2, ...Array(30).fill(0.05)];
    const boundaries = detectBoundaries(samplesFromDists(dists), opts);
    expect(boundaries).toEqual([30]);
  });

  it("adapts to noisy handheld footage", () => {
    // Constant medium distances (handheld) should not fire even above a
    // naive fixed threshold; a genuinely bigger spike should.
    const noisy = Array(60)
      .fill(0)
      .map((_, i) => 0.3 + 0.05 * Math.sin(i));
    const withCut = [...noisy, 1.8, ...noisy];
    const boundaries = detectBoundaries(samplesFromDists(withCut), opts);
    expect(boundaries).toEqual([60]);
  });
});

describe("summarizeShots", () => {
  it("single shot spans the whole clip when no boundaries", () => {
    const samples = samplesFromDists(Array(60).fill(0.05));
    const shots = summarizeShots(samples, [], 10, 0.5);
    expect(shots).toHaveLength(1);
    expect(shots[0].tStart).toBe(0);
    expect(shots[0].tEnd).toBe(10);
  });

  it("picks the sharpest frame near the motion peak as rep", () => {
    const samples: FrameSample[] = Array(30)
      .fill(0)
      .map((_, i) => ({
        t: i / 6,
        histDist: 0.05,
        motionDiff: i === 15 ? 20 : 1, // peak at t=2.5
        sharpness: i === 16 ? 900 : i === 2 ? 950 : 100, // sharpest-near-peak is i=16
      }));
    const shots = summarizeShots(samples, [], 5, 0.5);
    expect(shots).toHaveLength(1);
    expect(shots[0].motionPeakTime).toBeCloseTo(2.5, 5);
    expect(shots[0].repIndex).toBe(16); // i=2 is sharper but far from peak
  });

  it("splits into shots at boundaries with correct ranges", () => {
    const samples = samplesFromDists(Array(60).fill(0.05));
    const shots = summarizeShots(samples, [30], 10, 0.5);
    expect(shots).toHaveLength(2);
    expect(shots[0].tStart).toBe(0);
    expect(shots[0].tEnd).toBeCloseTo(5, 5);
    expect(shots[1].tStart).toBeCloseTo(5, 5);
    expect(shots[1].tEnd).toBe(10);
  });
});

describe("vector math", () => {
  it("l2Normalize produces unit vectors; dot = cosine", () => {
    const a = l2Normalize(new Float32Array([3, 4]));
    expect(Math.hypot(a[0], a[1])).toBeCloseTo(1, 5);
    const b = l2Normalize(new Float32Array([3, 4]));
    expect(dot(a, b)).toBeCloseTo(1, 5);
    const c = l2Normalize(new Float32Array([-4, 3]));
    expect(dot(a, c)).toBeCloseTo(0, 5);
  });
});
