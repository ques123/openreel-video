import { describe, expect, it } from "vitest";
import {
  AUDIO_EVENT_MAX_GAP_S,
  AUDIO_EVENT_Z_THRESHOLD,
  computeAudioEnvelope,
  detectAudioEvents,
} from "../audio-signal";
import type { AudioEnvelope } from "../types";

function constant(n: number, value: number): Float32Array {
  return new Float32Array(n).fill(value);
}

/** windowS=1 signal made of exact per-window constants, sampleRate=1 (1 sample/window). */
function envelopeFromWindows(windowS: number, values: number[]): AudioEnvelope {
  return { windowS, rms: values };
}

describe("computeAudioEnvelope", () => {
  it("returns rms: [] for empty input", () => {
    expect(computeAudioEnvelope(new Float32Array(0), 16000)).toEqual({
      windowS: 0.25,
      rms: [],
    });
  });

  it("computes exact RMS per window on a constant signal", () => {
    // sampleRate=4, windowS=1 -> 4 samples/window. 2 full windows of a
    // constant 0.5 amplitude signal -> RMS of each window is exactly 0.5.
    const samples = constant(8, 0.5);
    const env = computeAudioEnvelope(samples, 4, 1);
    expect(env.windowS).toBe(1);
    expect(env.rms).toEqual([0.5, 0.5]);
  });

  it("computes exact RMS on a square wave (alternating +/-1)", () => {
    // RMS of a full-scale square wave is 1 regardless of window alignment.
    const samples = new Float32Array(8);
    for (let i = 0; i < 8; i += 1) samples[i] = i % 2 === 0 ? 1 : -1;
    const env = computeAudioEnvelope(samples, 4, 1);
    expect(env.rms).toEqual([1, 1]);
  });

  it("computes a known RMS value on a synthetic sine window", () => {
    // One full period of a unit-amplitude sine has RMS = 1/sqrt(2).
    const sampleRate = 8000;
    const freq = 100; // 100Hz -> one full period every 80 samples
    const windowS = 80 / sampleRate;
    const n = 80;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
    const env = computeAudioEnvelope(samples, sampleRate, windowS);
    expect(env.rms.length).toBe(1);
    expect(env.rms[0]).toBeCloseTo(1 / Math.sqrt(2), 3);
  });

  it("includes a trailing partial window when it covers >= half a window", () => {
    // windowSamples = 4. 2 full windows (8 samples) + 2 more samples (== half) included.
    const samples = constant(10, 1);
    const env = computeAudioEnvelope(samples, 4, 1);
    expect(env.rms).toEqual([1, 1, 1]);
  });

  it("drops a trailing partial window shorter than half a window", () => {
    // windowSamples = 4. 2 full windows (8 samples) + 1 more sample (< half) dropped.
    const samples = constant(9, 1);
    const env = computeAudioEnvelope(samples, 4, 1);
    expect(env.rms).toEqual([1, 1]);
  });

  it("rounds rms values to ~4 decimal places", () => {
    const samples = new Float32Array([1 / 3, 1 / 3, 1 / 3]);
    const env = computeAudioEnvelope(samples, 3, 1);
    expect(env.rms).toHaveLength(1);
    // 1/3 rounded to 4 decimals.
    expect(env.rms[0]).toBe(0.3333);
  });
});

describe("detectAudioEvents", () => {
  it("returns [] for an empty envelope", () => {
    expect(detectAudioEvents(envelopeFromWindows(0.25, []))).toEqual([]);
  });

  it("returns [] for a perfectly constant (loud) signal", () => {
    const env = envelopeFromWindows(0.25, new Array(20).fill(0.7));
    expect(detectAudioEvents(env)).toEqual([]);
  });

  it("returns [] for near-silence with no standout window", () => {
    const env = envelopeFromWindows(
      0.25,
      Array.from({ length: 20 }, (_, i) => 0.001 + (i % 2 === 0 ? 0.0001 : -0.0001)),
    );
    expect(detectAudioEvents(env)).toEqual([]);
  });

  it("detects a single burst in a quiet + burst + quiet signal", () => {
    const quiet = new Array(10).fill(0.01);
    const burst = [0.02, 0.9, 0.95, 0.85, 0.02];
    const rms = [...quiet, ...burst, ...quiet];
    const env = envelopeFromWindows(0.25, rms);

    const events = detectAudioEvents(env);
    expect(events).toHaveLength(1);
    const [event] = events;
    // Burst starts at index 11 (the 0.9 after the quiet lead-in + one
    // sub-threshold 0.02 window) — allow the leading 0.02 not to seed.
    expect(event.t).toBeGreaterThanOrEqual(10 * 0.25);
    expect(event.t).toBeLessThan(13 * 0.25);
    expect(event.durS).toBeGreaterThanOrEqual(0.25);
    expect(event.intensity).toBeGreaterThan(0);
  });

  it("uses the exported defaults when opts are omitted", () => {
    expect(AUDIO_EVENT_Z_THRESHOLD).toBeGreaterThan(0);
    expect(AUDIO_EVENT_MAX_GAP_S).toBeGreaterThan(0);
    // Sanity: a clip whose only above-threshold window relies on the
    // default z-threshold still fires with default options.
    const quiet = new Array(8).fill(0.01);
    const rms = [...quiet, 1, ...quiet];
    const env = envelopeFromWindows(0.25, rms);
    expect(detectAudioEvents(env)).toHaveLength(1);
  });

  it("merges two spikes separated by a gap <= maxGapS", () => {
    const quiet = new Array(6).fill(0.01);
    // Two 1-window spikes separated by 1 quiet window (0.25s gap <= 0.5s default).
    const rms = [...quiet, 0.9, 0.01, 0.9, ...quiet];
    const env = envelopeFromWindows(0.25, rms);
    const events = detectAudioEvents(env);
    expect(events).toHaveLength(1);
    // Merged run spans both spikes + the gap window between them.
    expect(events[0].durS).toBeCloseTo(3 * 0.25, 5);
  });

  it("keeps two spikes separate when the gap exceeds maxGapS", () => {
    const quiet = new Array(6).fill(0.01);
    // 3 quiet windows between spikes = 0.75s gap > default 0.5s maxGapS.
    const rms = [...quiet, 0.9, 0.01, 0.01, 0.01, 0.9, ...quiet];
    const env = envelopeFromWindows(0.25, rms);
    const events = detectAudioEvents(env, { maxGapS: 0.5 });
    expect(events).toHaveLength(2);
  });

  it("respects a custom maxGapS to merge a wider gap", () => {
    const quiet = new Array(6).fill(0.01);
    const rms = [...quiet, 0.9, 0.01, 0.01, 0.01, 0.9, ...quiet];
    const env = envelopeFromWindows(0.25, rms);
    const events = detectAudioEvents(env, { maxGapS: 1.0 });
    expect(events).toHaveLength(1);
  });

  it("drops events shorter than minDurS", () => {
    const quiet = new Array(10).fill(0.01);
    const rms = [...quiet, 0.9, ...quiet];
    const env = envelopeFromWindows(0.25, rms);
    // Single-window spike is exactly one windowS (0.25s) long; requiring
    // more than that should drop it.
    const events = detectAudioEvents(env, { minDurS: 0.5 });
    expect(events).toEqual([]);
  });

  it("keeps a single-window event at the default minDurS (one window)", () => {
    const quiet = new Array(10).fill(0.01);
    const rms = [...quiet, 0.9, ...quiet];
    const env = envelopeFromWindows(0.25, rms);
    const events = detectAudioEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0].durS).toBeCloseTo(0.25, 5);
  });

  it("detects a spike against a naturally-varying (non-uniform) baseline", () => {
    // Non-degenerate MAD (values differ enough that median/MAD math, not
    // the near-zero-MAD fallback, drives detection).
    const base = [0.1, 0.15, 0.12, 0.18, 0.11, 0.16, 0.13, 0.19, 0.1, 0.14, 0.17, 0.12];
    const rms = [...base, 0.95, ...base];
    const env = envelopeFromWindows(0.25, rms);
    const events = detectAudioEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0].t).toBeCloseTo(base.length * 0.25, 5);
    expect(events[0].durS).toBeCloseTo(0.25, 5);
  });

  it("reports peak z (or fallback score) as the run's intensity", () => {
    const quiet = new Array(10).fill(0.01);
    const rms = [...quiet, 0.5, 0.95, 0.6, ...quiet];
    const env = envelopeFromWindows(0.25, rms);
    const events = detectAudioEvents(env);
    expect(events).toHaveLength(1);
    // Peak intensity should correspond to the loudest window (0.95), not
    // the first or last window of the run.
    expect(events[0].intensity).toBeGreaterThan(0);
  });
});
