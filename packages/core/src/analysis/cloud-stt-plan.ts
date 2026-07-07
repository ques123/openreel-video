/**
 * VAD-gated cloud transcription upload planning (wizz.video public
 * fast-follow — see docs/wizz-video-plan.md §WS-E).
 *
 * Today's cloud STT path (apps/web/src/services/groq-stt.ts
 * transcribeCloudPcm) uploads a clip's ENTIRE audio in fixed 600s macro-
 * chunks, regardless of whether there's any speech in it. On quiet footage
 * that (a) makes whisper hallucinate on non-speech (the documented Polish-
 * silence-boilerplate failure — see the memory ledger's "transcript source
 * pick" entry) and (b) bills seconds nobody asked for. The fix is to upload
 * only the speech regions vad-regions.ts already knows how to compute
 * (merge/pad/drop/split), packed efficiently into upload requests.
 *
 * The economics matter as much as the correctness: Groq (like OpenAI) bills
 * every transcription request a 10-second MINIMUM. A clip with many short,
 * scattered speech blips would, if uploaded as one request per region, bill
 * far MORE than the un-gated path (e.g. 20 blips of 1s each = 20 requests x
 * 10s floor = 200s billed, worse than a single un-gated 600s chunk covering a
 * 200s clip). `planCloudSttUpload` therefore PACKS multiple regions into
 * shared upload chunks (bin-packed up to `maxChunkS`, matching the existing
 * 600s macro-chunk size) so the number of billed requests — and therefore
 * the floor's total contribution — stays as small as the content allows.
 * Because every chunk this function produces is bounded by the SAME 600s cap
 * the un-gated path already chunks at, and packed chunks always carry LESS
 * total audio than the un-gated chunks covering the same span (gated content
 * is a subset of the clip's full duration), the gated billed total can never
 * exceed the un-gated billed total for the same clip — see
 * cloud-stt-plan.test.ts's economics suite, including the "many tiny
 * scattered regions" adversarial case this comment describes.
 *
 * Everything here is pure (no fetch, no PCM slicing, no models) — the caller
 * (groq-stt.ts) uses the sample offsets in each plan's regions to slice and
 * concatenate the ACTUAL PCM per chunk before encoding/uploading, and uses
 * remapChunkTimeToSourceS/remapCloudSttSegments afterward to translate the
 * (chunk-relative) transcription result back into absolute clip time.
 */

import type { TranscriptSegment } from "./types";
import type { VadRegion } from "./vad-regions";

/** Default cap on packed seconds per upload chunk — mirrors CLOUD_CHUNK_S in groq-stt.ts (and MACRO_CHUNK_S in whisper-worker.ts). */
export const DEFAULT_CLOUD_STT_MAX_CHUNK_S = 600;

/**
 * One packed speech region within an upload chunk's concatenated audio.
 * `srcStartS`/`srcEndS` are absolute seconds in the ORIGINAL source clip;
 * `srcStartSample`/`srcEndSample` are the matching sample offsets into the
 * original PCM (so the caller can slice without re-deriving/rounding
 * offsets independently of what this plan already computed); `chunkOffsetS`
 * is where this region's audio begins within the chunk's packed/concatenated
 * timeline — the anchor remapChunkTimeToSourceS needs to translate a
 * transcription result's chunk-relative timestamp back to source time.
 */
export interface CloudSttRegionMap {
  srcStartS: number;
  srcEndS: number;
  srcStartSample: number;
  srcEndSample: number;
  chunkOffsetS: number;
}

/** One upload request's worth of packed audio. */
export interface CloudSttChunkPlan {
  /** Total packed audio duration, seconds (sum of this chunk's regions). */
  durationS: number;
  /** Total packed sample count (sum of this chunk's regions). */
  sampleCount: number;
  /** Packed regions, in source-time order, each region contiguous within the chunk's concatenated audio (chunkOffsetS values are ascending with no gaps). */
  regions: CloudSttRegionMap[];
}

export interface CloudSttUploadPlan {
  /** Zero chunks for a zero-speech clip — see "zero-speech clip -> zero uploads" in the test suite. */
  chunks: CloudSttChunkPlan[];
  /** Total speech seconds across every chunk (== Σ chunk.durationS) — the pre-billing content total, for telemetry/tests. */
  totalSpeechS: number;
}

export interface PlanCloudSttUploadOptions {
  /** Max packed seconds per upload chunk. Default DEFAULT_CLOUD_STT_MAX_CHUNK_S (600). */
  maxChunkS?: number;
}

/**
 * Packs (already merged/padded — see vad-regions.ts's processVadRegions)
 * speech regions into upload chunks: regions are consumed in ascending start
 * order and appended to the CURRENT chunk as long as doing so keeps it at or
 * under `maxChunkS`; when the next region would overflow, the current chunk
 * closes and a new one starts. This greedy pack is what keeps the "many tiny
 * regions" case cheap: they fill one chunk almost to the cap instead of each
 * becoming its own 10s-floor request.
 *
 * Defensive, NOT trusting the caller to have already bounded region length:
 * regions are clamped to [0, pcmLength/sampleRate], sorted, and any region
 * (or leftover slice of one) longer than `maxChunkS` is itself split — so
 * this function's per-chunk cap holds regardless of what processVadRegions
 * was configured with upstream.
 */
export function planCloudSttUpload(
  pcmLength: number,
  sampleRate: number,
  vadRegions: VadRegion[],
  opts: PlanCloudSttUploadOptions = {},
): CloudSttUploadPlan {
  const maxChunkS = opts.maxChunkS ?? DEFAULT_CLOUD_STT_MAX_CHUNK_S;
  if (pcmLength <= 0 || sampleRate <= 0 || maxChunkS <= 0) return { chunks: [], totalSpeechS: 0 };
  const totalDurationS = pcmLength / sampleRate;

  const sanitized = vadRegions
    .map((r) => ({
      start: Math.min(Math.max(0, r.start), totalDurationS),
      end: Math.min(Math.max(0, r.end), totalDurationS),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  // Defensive re-split: never assume the input already respects maxChunkS.
  const capped: VadRegion[] = [];
  for (const r of sanitized) {
    let start = r.start;
    while (r.end - start > maxChunkS) {
      capped.push({ start, end: start + maxChunkS });
      start += maxChunkS;
    }
    capped.push({ start, end: r.end });
  }

  const chunks: CloudSttChunkPlan[] = [];
  let current: CloudSttRegionMap[] = [];
  let currentDurationS = 0;

  const flush = () => {
    if (current.length === 0) return;
    const sampleCount = current.reduce((s, r) => s + (r.srcEndSample - r.srcStartSample), 0);
    chunks.push({ durationS: currentDurationS, sampleCount, regions: current });
    current = [];
    currentDurationS = 0;
  };

  for (const r of capped) {
    const srcStartSample = Math.round(r.start * sampleRate);
    const srcEndSample = Math.min(pcmLength, Math.round(r.end * sampleRate));
    if (srcEndSample <= srcStartSample) continue;
    const regionDurationS = (srcEndSample - srcStartSample) / sampleRate;

    if (currentDurationS > 0 && currentDurationS + regionDurationS > maxChunkS) flush();

    current.push({
      srcStartS: r.start,
      srcEndS: r.end,
      srcStartSample,
      srcEndSample,
      chunkOffsetS: currentDurationS,
    });
    currentDurationS += regionDurationS;
  }
  flush();

  const totalSpeechS = chunks.reduce((s, c) => s + c.durationS, 0);
  return { chunks, totalSpeechS };
}

/**
 * Maps a timestamp measured within an upload chunk's packed/concatenated
 * audio back to absolute source-clip seconds, using that chunk's region map
 * (CloudSttChunkPlan.regions, as returned by planCloudSttUpload). Falls back
 * to clamping into the NEAREST region edge when `chunkTimeS` doesn't land
 * inside any region's span — Groq's own segment/word boundaries can land a
 * few ms outside the exact packed edges (rounding, or a trailing/leading
 * silence sliver the model still reports a boundary against). Returns
 * `chunkTimeS` unchanged (nothing to map against) when `regions` is empty.
 */
export function remapChunkTimeToSourceS(chunkTimeS: number, regions: CloudSttRegionMap[]): number {
  if (regions.length === 0) return chunkTimeS;

  for (const r of regions) {
    const regionDurationS = r.srcEndS - r.srcStartS;
    if (chunkTimeS >= r.chunkOffsetS && chunkTimeS <= r.chunkOffsetS + regionDurationS) {
      return r.srcStartS + (chunkTimeS - r.chunkOffsetS);
    }
  }

  let nearestRegion = regions[0];
  let nearestEdgeS = regions[0].chunkOffsetS;
  let nearestDist = Math.abs(chunkTimeS - nearestEdgeS);
  for (const r of regions) {
    const regionDurationS = r.srcEndS - r.srcStartS;
    for (const edge of [r.chunkOffsetS, r.chunkOffsetS + regionDurationS]) {
      const dist = Math.abs(chunkTimeS - edge);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestRegion = r;
        nearestEdgeS = edge;
      }
    }
  }
  const regionDurationS = nearestRegion.srcEndS - nearestRegion.srcStartS;
  const clamped = Math.min(
    Math.max(chunkTimeS, nearestRegion.chunkOffsetS),
    nearestRegion.chunkOffsetS + regionDurationS,
  );
  return nearestRegion.srcStartS + (clamped - nearestRegion.chunkOffsetS);
}

/**
 * Remaps a whole chunk-relative TranscriptSegment[] (as decoded from one
 * upload's response, before offsetting — i.e. groq-stt.ts should call its
 * existing toTranscriptSegments with offsetS=0 first) back to absolute
 * source-clip time via remapChunkTimeToSourceS.
 */
export function remapCloudSttSegments(
  segments: TranscriptSegment[],
  regions: CloudSttRegionMap[],
): TranscriptSegment[] {
  return segments.map((s) => ({
    ...s,
    t0: remapChunkTimeToSourceS(s.t0, regions),
    t1: remapChunkTimeToSourceS(s.t1, regions),
  }));
}
