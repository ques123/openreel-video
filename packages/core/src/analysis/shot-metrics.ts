/**
 * Pure per-frame metrics and shot-boundary detection for the perception funnel.
 *
 * All functions operate on raw RGBA pixel buffers (as produced by
 * CanvasRenderingContext2D.getImageData) so they are trivially unit-testable
 * and have no DOM/worker dependencies.
 */

/** 16(H) x 4(S) x 4(V) = 256 bins. */
export const HIST_BINS = 256;
const H_BINS = 16;
const S_BINS = 4;
const V_BINS = 4;
/** Sample every 2nd pixel in each dimension for speed. */
const PIXEL_STRIDE = 2;

/**
 * Convert an RGBA buffer to an L1-normalized joint HSV histogram (16x4x4).
 */
export function hsvHistogram(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const hist = new Float32Array(HIST_BINS);
  let count = 0;

  for (let y = 0; y < height; y += PIXEL_STRIDE) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += PIXEL_STRIDE) {
      const i = (rowOffset + x) * 4;
      const r = rgba[i] / 255;
      const g = rgba[i + 1] / 255;
      const b = rgba[i + 2] / 255;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;

      // Hue in [0, 1)
      let h = 0;
      if (delta > 0) {
        if (max === r) {
          h = ((g - b) / delta) % 6;
        } else if (max === g) {
          h = (b - r) / delta + 2;
        } else {
          h = (r - g) / delta + 4;
        }
        h /= 6;
        if (h < 0) h += 1;
      }
      const s = max > 0 ? delta / max : 0;
      const v = max;

      const hBin = Math.min(H_BINS - 1, Math.floor(h * H_BINS));
      const sBin = Math.min(S_BINS - 1, Math.floor(s * S_BINS));
      const vBin = Math.min(V_BINS - 1, Math.floor(v * V_BINS));
      hist[hBin * S_BINS * V_BINS + sBin * V_BINS + vBin] += 1;
      count += 1;
    }
  }

  if (count > 0) {
    for (let i = 0; i < HIST_BINS; i += 1) hist[i] /= count;
  }
  return hist;
}

/** L1 distance between two L1-normalized histograms. Range [0, 2]. */
export function histDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += Math.abs(a[i] - b[i]);
  return d;
}

/** Extract a grayscale (luma, 0..255) plane from RGBA. */
export function toGrayscale(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
    // Rec. 601 luma
    gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return gray;
}

/** Mean absolute luma difference between two same-sized grayscale planes (0..255). */
export function lumaDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Variance of a 3x3 Laplacian over a grayscale plane. Standard blur metric:
 * higher = sharper. Border pixels are skipped.
 */
export function laplacianVariance(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const lap =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      n += 1;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export interface FrameSample {
  /** Timestamp, seconds. */
  t: number;
  /** L1 distance of this frame's histogram to the previous sampled frame (0 for first). */
  histDist: number;
  /** Mean |deltaY| to the previous sampled frame (0 for first). */
  motionDiff: number;
  /** Laplacian variance (sharpness). */
  sharpness: number;
}

export interface BoundaryOptions {
  /** Absolute floor for a boundary to fire. */
  absFloor: number;
  /** k in mean + k*std. */
  k: number;
  /** Sliding window size in samples. */
  window: number;
  /** Minimum shot length, seconds. */
  minShotLengthS: number;
}

/**
 * Detect shot boundaries in a series of frame samples using an adaptive
 * threshold: a boundary fires at sample i when
 *   histDist[i] > max(absFloor, mean + k*std)
 * over the previous `window` distances, and the shot being closed is at
 * least `minShotLengthS` long.
 *
 * Returns indices into `samples` that BEGIN a new shot (never 0).
 */
export function detectBoundaries(
  samples: FrameSample[],
  opts: BoundaryOptions,
): number[] {
  const boundaries: number[] = [];
  let lastBoundaryT = samples.length > 0 ? samples[0].t : 0;

  for (let i = 1; i < samples.length; i += 1) {
    const start = Math.max(1, i - opts.window);
    let mean = 0;
    let n = 0;
    for (let j = start; j < i; j += 1) {
      mean += samples[j].histDist;
      n += 1;
    }
    let threshold = opts.absFloor;
    if (n >= 3) {
      mean /= n;
      let varSum = 0;
      for (let j = start; j < i; j += 1) {
        const dv = samples[j].histDist - mean;
        varSum += dv * dv;
      }
      const std = Math.sqrt(varSum / n);
      threshold = Math.max(opts.absFloor, mean + opts.k * std);
    }

    if (
      samples[i].histDist > threshold &&
      samples[i].t - lastBoundaryT >= opts.minShotLengthS
    ) {
      boundaries.push(i);
      lastBoundaryT = samples[i].t;
    }
  }

  return boundaries;
}

export interface ShotSummary {
  tStart: number;
  tEnd: number;
  /** Index range [iStart, iEnd) into the samples array. */
  iStart: number;
  iEnd: number;
  motionScore: number;
  motionPeakTime: number;
  /** Index (into samples) of the chosen representative frame. */
  repIndex: number;
  repSharpness: number;
}

/**
 * Summarize shots from samples + boundary indices. The representative frame is
 * the sharpest sample within `peakRadiusS` seconds of the motion peak
 * (falling back to the sharpest sample in the shot).
 */
export function summarizeShots(
  samples: FrameSample[],
  boundaries: number[],
  durationS: number,
  peakRadiusS: number,
): ShotSummary[] {
  if (samples.length === 0) return [];
  const starts = [0, ...boundaries];
  const shots: ShotSummary[] = [];

  for (let s = 0; s < starts.length; s += 1) {
    const iStart = starts[s];
    const iEnd = s + 1 < starts.length ? starts[s + 1] : samples.length;
    const tStart = samples[iStart].t;
    const tEnd = s + 1 < starts.length ? samples[iEnd].t : durationS;

    // Motion: mean/max over diffs strictly inside the shot (skip the boundary
    // frame itself — its diff is the cut, not motion).
    let motionSum = 0;
    let motionN = 0;
    let peakDiff = -1;
    let peakTime = tStart;
    for (let i = iStart + 1; i < iEnd; i += 1) {
      motionSum += samples[i].motionDiff;
      motionN += 1;
      if (samples[i].motionDiff > peakDiff) {
        peakDiff = samples[i].motionDiff;
        peakTime = samples[i].t;
      }
    }
    const motionScore = motionN > 0 ? motionSum / motionN : 0;

    // Rep frame: sharpest within +/- peakRadiusS of the peak, else sharpest in shot.
    let repIndex = iStart;
    let repSharpness = -1;
    for (let i = iStart; i < iEnd; i += 1) {
      if (Math.abs(samples[i].t - peakTime) <= peakRadiusS) {
        if (samples[i].sharpness > repSharpness) {
          repSharpness = samples[i].sharpness;
          repIndex = i;
        }
      }
    }
    if (repSharpness < 0) {
      for (let i = iStart; i < iEnd; i += 1) {
        if (samples[i].sharpness > repSharpness) {
          repSharpness = samples[i].sharpness;
          repIndex = i;
        }
      }
    }

    shots.push({
      tStart,
      tEnd,
      iStart,
      iEnd,
      motionScore,
      motionPeakTime: peakTime,
      repIndex,
      repSharpness: samples[repIndex].sharpness,
    });
  }

  return shots;
}

/** L2-normalize a vector in place; returns the same array. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < v.length; i += 1) v[i] /= norm;
  }
  return v;
}

/** Dot product (= cosine for L2-normalized vectors). */
export function dot(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += a[i] * b[i];
  return d;
}
