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
  void samples; void sampleRate; void windowS;
  throw new Error("not implemented");
}

/**
 * Detect loudness events: runs of envelope windows whose robust z-score
 * (median/MAD baseline over the whole clip) exceeds the threshold. Merges
 * runs separated by gaps <= maxGapS, drops runs shorter than minDurS.
 * A near-silent or uniformly loud clip yields [] (MAD guard: when MAD is
 * ~0, fall back to a fraction of the max so constant audio never fires).
 */
export function detectAudioEvents(
  envelope: AudioEnvelope,
  opts: AudioEventOptions = {},
): AudioEvent[] {
  void envelope; void opts;
  throw new Error("not implemented");
}
