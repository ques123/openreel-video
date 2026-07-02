import { describe, expect, it } from "vitest";
import { StreamingResampler } from "../audio-resample";

/** Reference: direct one-shot linear resample over the full signal. */
function directResample(signal: Float32Array, ratio: number): Float32Array {
  const out: number[] = [];
  for (let pos = 0; pos <= signal.length - 1; pos += ratio) {
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, signal.length - 1);
    const frac = pos - i0;
    out.push(signal[i0] * (1 - frac) + signal[i1] * frac);
  }
  return Float32Array.from(out);
}

function sine(n: number, freq: number, rate: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function chunked(signal: Float32Array, sizes: number[]): Float32Array[] {
  const chunks: Float32Array[] = [];
  let offset = 0;
  let s = 0;
  while (offset < signal.length) {
    const size = Math.min(sizes[s % sizes.length], signal.length - offset);
    chunks.push(signal.slice(offset, offset + size));
    offset += size;
    s += 1;
  }
  return chunks;
}

describe("StreamingResampler", () => {
  it("matches a direct linear resample regardless of chunking (48k -> 16k)", () => {
    const rate = 48000;
    const signal = sine(rate, 440, rate); // 1s of 440Hz
    const ratio = rate / 16000;
    const reference = directResample(signal, ratio);

    for (const sizes of [[1024], [4096, 333, 1], [signal.length]]) {
      const resampler = new StreamingResampler(ratio);
      for (const chunk of chunked(signal, sizes)) resampler.push(chunk);
      const streamed = resampler.finish();

      // Streamed version may differ by ±1 sample at the very end.
      expect(Math.abs(streamed.length - reference.length)).toBeLessThanOrEqual(1);
      const n = Math.min(streamed.length, reference.length);
      let maxErr = 0;
      for (let i = 0; i < n; i += 1) {
        maxErr = Math.max(maxErr, Math.abs(streamed[i] - reference[i]));
      }
      // Chunk-boundary interpolation may clamp differently than the direct
      // pass at exact boundaries; tolerance is well below audibility.
      expect(maxErr).toBeLessThan(0.01);
    }
  });

  it("handles 44.1k -> 16k (non-integer ratio)", () => {
    const rate = 44100;
    const signal = sine(rate, 200, rate);
    const ratio = rate / 16000;
    const resampler = new StreamingResampler(ratio);
    for (const chunk of chunked(signal, [1000])) resampler.push(chunk);
    const out = resampler.finish();
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2);
    // Signal energy preserved (rough check).
    const rms = Math.sqrt(out.reduce((s, v) => s + v * v, 0) / out.length);
    expect(rms).toBeGreaterThan(0.6);
    expect(rms).toBeLessThan(0.8);
  });

  it("output crosses block boundaries correctly (> 1M samples)", () => {
    const ratio = 3;
    const n = 4 * (1 << 20) * ratio; // ~4M output samples -> multiple blocks
    const resampler = new StreamingResampler(ratio);
    const chunk = new Float32Array(1 << 16).fill(0.5);
    let pushed = 0;
    while (pushed < n) {
      resampler.push(chunk);
      pushed += chunk.length;
    }
    const out = resampler.finish();
    expect(out.length).toBeGreaterThan(1 << 20);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[out.length - 1]).toBeCloseTo(0.5, 5);
    expect(out[1 << 20]).toBeCloseTo(0.5, 5); // first sample of block 2
  });
});
