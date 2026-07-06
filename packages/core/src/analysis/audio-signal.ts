/**
 * Audio loudness signals: RMS envelope + event (spike) detection.
 *
 * Computed on the SAME 16k mono Float32Array the whisper pass decodes, so
 * the envelope is free wherever a transcript pass runs. Pure functions —
 * the whisper worker calls them and posts results back; nothing here does
 * I/O or touches workers.
 */

import type { AudioEnvelope, AudioEvent } from "./types";

/** Default RMS window, seconds. 0.25s ≈ syllable-scale; sparkline-friendly. */
export const AUDIO_ENVELOPE_WINDOW_S = 0.25;

/** Default robust z-score threshold for `detectAudioEvents`. */
export const AUDIO_EVENT_Z_THRESHOLD = 2.5;
/** Default merge gap for `detectAudioEvents`, seconds. */
export const AUDIO_EVENT_MAX_GAP_S = 0.5;

/** MAD values below this are treated as "effectively zero" (guard against div-by-~0). */
const MAD_EPS = 1e-6;

export interface AudioEventOptions {
  /**
   * Robust z-score (vs median/MAD of the clip's envelope) a window must
   * exceed to seed an event. ~2.5 catches cheers/laughter without firing
   * on ordinary speech dynamics.
   */
  zThreshold?: number;
  /** Windows may dip below the threshold for this long without ending the event, seconds. */
  maxGapS?: number;
  /** Discard events shorter than this, seconds (transient clicks). */
  minDurS?: number;
}

/**
 * Compute the RMS loudness envelope of mono samples.
 * Returns one RMS value per `windowS` window (last partial window included
 * when it covers at least half a window). Empty/silent input → rms: [].
 */
export function computeAudioEnvelope(
  samples: Float32Array,
  sampleRate: number,
  windowS: number = AUDIO_ENVELOPE_WINDOW_S,
): AudioEnvelope {
  if (samples.length === 0 || sampleRate <= 0 || windowS <= 0) {
    return { windowS, rms: [] };
  }

  const windowSamples = Math.max(1, Math.round(windowS * sampleRate));
  const rms: number[] = [];

  for (let i = 0; i < samples.length; i += windowSamples) {
    const len = Math.min(windowSamples, samples.length - i);
    // Trailing partial window: only keep it when it covers >= half a window,
    // otherwise the last sliver would skew a sparkline/event baseline.
    if (len < windowSamples && len < windowSamples / 2) break;

    let sumSq = 0;
    for (let j = 0; j < len; j += 1) {
      const v = samples[i + j];
      sumSq += v * v;
    }
    const value = Math.sqrt(sumSq / len);
    // Round to ~4 decimals to keep the dossier JSON small.
    rms.push(Math.round(value * 10000) / 10000);
  }

  return { windowS, rms };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Detect loudness events: runs of envelope windows whose robust z-score
 * (median/MAD baseline over the whole clip) exceeds the threshold. Merges
 * runs separated by gaps <= maxGapS, drops runs shorter than minDurS.
 *
 * Robust z-score: z = 0.6745 * (x - median) / MAD, the standard
 * normal-consistent transform of the median absolute deviation (0.6745 =
 * Phi^-1(0.75), which makes MAD comparable to a standard deviation for
 * normally-distributed data). Median/MAD are computed over the WHOLE clip's
 * envelope, once, so a single burst can't drag its own baseline toward it.
 *
 * MAD guard: MAD is robust to a *minority* of outliers, so a short loud
 * burst in an otherwise quiet/uniform clip can leave MAD at ~0 (division
 * would blow up). When that happens:
 *  - if the loudest window is also indistinguishable from the median (a
 *    genuinely constant or uniformly near-silent clip), there is nothing to
 *    detect — return [].
 *  - otherwise (the quiet-with-a-rare-burst case) fall back to a simple
 *    baseline distance: seed windows louder than max(rms) * 0.5, and report
 *    their intensity as x / (max(rms) * 0.5) in place of a MAD-based z-score.
 */
export function detectAudioEvents(
  envelope: AudioEnvelope,
  opts: AudioEventOptions = {},
): AudioEvent[] {
  const { rms, windowS } = envelope;
  const zThreshold = opts.zThreshold ?? AUDIO_EVENT_Z_THRESHOLD;
  const maxGapS = opts.maxGapS ?? AUDIO_EVENT_MAX_GAP_S;
  // A single loud window must still be able to form an event: a fixed 0.3s
  // floor would be sub-window at the default 0.25s windowS and silently
  // drop every single-window spike. Default to one window instead.
  const minDurS = opts.minDurS ?? windowS;

  if (rms.length === 0 || windowS <= 0) return [];

  const med = median(rms);
  const mad = median(rms.map((x) => Math.abs(x - med)));
  const max = Math.max(...rms);

  let useFallback = false;
  if (mad < MAD_EPS) {
    if (max - med < MAD_EPS) return []; // uniform (incl. near-silent): nothing stands out
    useFallback = true;
  }
  const fallbackBaseline = max * 0.5;

  const score = (x: number): number =>
    useFallback ? (fallbackBaseline > 0 ? x / fallbackBaseline : 0) : (0.6745 * (x - med)) / mad;
  const seeded = (x: number): boolean =>
    useFallback ? x > fallbackBaseline : score(x) > zThreshold;

  const maxGapWindows = Math.floor(maxGapS / windowS + 1e-9);

  interface Run {
    startIdx: number;
    lastAboveIdx: number;
    endIdx: number;
    peakZ: number;
  }
  const runs: Run[] = [];
  let current: Run | null = null;

  for (let i = 0; i < rms.length; i += 1) {
    if (!seeded(rms[i])) continue;
    const z = score(rms[i]);
    if (current && i - current.lastAboveIdx - 1 <= maxGapWindows) {
      current.endIdx = i;
      current.lastAboveIdx = i;
      current.peakZ = Math.max(current.peakZ, z);
    } else {
      if (current) runs.push(current);
      current = { startIdx: i, lastAboveIdx: i, endIdx: i, peakZ: z };
    }
  }
  if (current) runs.push(current);

  const events: AudioEvent[] = [];
  for (const run of runs) {
    const durS = (run.endIdx - run.startIdx + 1) * windowS;
    if (durS < minDurS - 1e-9) continue;
    events.push({ t: run.startIdx * windowS, durS, intensity: run.peakZ });
  }
  return events;
}
