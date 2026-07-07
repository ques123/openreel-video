/**
 * Pure state for the public bench: a reducer over FunnelProgressEvent (the
 * same core event stream apps/web/src/pages/lab/use-perception-lab.ts
 * consumes) plus a couple of publicflow-only actions (clip-added/removed),
 * and pure projections from that raw state into the public vocabulary
 * types.ts specifies (PublicClipStatus, the batch summary line, the model
 * prep strip). No React, no workers, no orchestrator — use-public-pipeline.ts
 * is the thin impure shell around this.
 *
 * Time is passed in explicitly (every action that needs "now" carries an
 * `atMs`, every projection takes a `nowMs`) rather than read via Date.now()
 * inside this module, so the whole thing stays a deterministic pure
 * function of its inputs — trivially unit-testable without faking timers.
 *
 * Progress-honesty policy (see docs/wizz-video-plan.md §10 Scene 2 — "real
 * ETAs from measured per-frame rates"): a stage's per-clip progress bar uses
 * a REAL incremental signal when one exists (decode position for "watching
 * your footage", captionsDone/captionsTotal for "describing what it sees")
 * and is 0 for "listening for speech" — whisper's local pass is a single
 * atomic event with no incremental signal to show, and faking an
 * interpolated number would be exactly the kind of fabricated progress this
 * product's honesty stance rejects. The BATCH summary line's ETA is where
 * "measured rates" apply: a blended end-to-end (wall-ms per source-second)
 * rate is tracked across clips that have already finished THIS session and
 * used to extrapolate the rest — see RateTracker below.
 */
import type { ClipDossier, FunnelProgressEvent } from "@openreel/core";
import type { FootageCap } from "@wizz/contracts";
import type { PublicClip, PublicClipStatus } from "../types";

// ---------------------------------------------------------------------------
// Raw per-clip state
// ---------------------------------------------------------------------------

export type RawClipOutcome = "analyzing" | "done" | "error";

export interface RawClipState {
  id: string;
  fileName: string;
  /** When this clip's analysis was (re)started — the batch ETA's elapsed-time anchor. */
  addedAtMs: number;
  durationS: number;
  metaKnown: boolean;
  thumbnailUrl: string | null;
  /** OPFS ingest progress 0..1, or null once decoding starts (mirrors LabClip). */
  ingestProgress: number | null;
  decodeT: number;
  ingestWindow: { window: number; windows: number } | null;
  /** The whisper worker's single "transcript" event has fired for this clip. */
  transcriptReceived: boolean;
  captionsDone: number;
  captionsTotal: number;
  outcome: RawClipOutcome;
  errorMessage?: string;
  /** Set once the clip reaches "ready" — feeds RateTracker (see recordClipReady). */
  readyAtMs: number | null;
  dossier: ClipDossier | null;
}

export interface PipelineState {
  clips: RawClipState[];
}

export const initialPipelineState: PipelineState = { clips: [] };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type PipelineAction =
  | { type: "clip-added"; id: string; fileName: string; atMs: number }
  | { type: "clip-removed"; id: string }
  | { type: "event"; event: FunnelProgressEvent; atMs: number };

function updateClip(
  state: PipelineState,
  id: string,
  update: (clip: RawClipState) => RawClipState,
): PipelineState {
  return { clips: state.clips.map((c) => (c.id === id ? update(c) : c)) };
}

function freshClip(id: string, fileName: string, atMs: number): RawClipState {
  return {
    id,
    fileName,
    addedAtMs: atMs,
    durationS: 0,
    metaKnown: false,
    thumbnailUrl: null,
    ingestProgress: null,
    decodeT: 0,
    ingestWindow: null,
    transcriptReceived: false,
    captionsDone: 0,
    captionsTotal: 0,
    outcome: "analyzing",
    errorMessage: undefined,
    readyAtMs: null,
    dossier: null,
  };
}

/**
 * Pure reducer. `clip-added` both adds a NEW clip and — when `id` already
 * exists — resets it in place to a fresh analyzing state (retryClip reuses
 * the same public id so the UI row doesn't reorder/disappear-and-reappear).
 */
export function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case "clip-added": {
      const fresh = freshClip(action.id, action.fileName, action.atMs);
      const exists = state.clips.some((c) => c.id === action.id);
      return exists
        ? updateClip(state, action.id, () => fresh)
        : { clips: [...state.clips, fresh] };
    }

    case "clip-removed":
      return { clips: state.clips.filter((c) => c.id !== action.id) };

    case "event": {
      const e = action.event;
      switch (e.kind) {
        case "meta":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            durationS: e.durationS,
            metaKnown: true,
          }));
        case "ingest-progress":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            ingestProgress: e.bytesTotal > 0 ? e.bytesDone / e.bytesTotal : 0,
          }));
        case "ingest-window":
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            ingestWindow: { window: e.window, windows: e.windows },
          }));
        case "decode-progress":
          return updateClip(state, e.clipId, (c) => ({ ...c, decodeT: e.t, ingestProgress: null }));
        case "shot":
          // The first shot's thumbnail is the clip row's thumbnail (PublicClip.thumbnailUrl).
          return updateClip(state, e.clipId, (c) =>
            c.thumbnailUrl ? c : { ...c, thumbnailUrl: e.shot.thumbnailDataUrl },
          );
        case "dense-captions":
          // Captions catching up can be what MAKES a clip ready (clip-done
          // may already have landed while captions were still behind) — stamp
          // readyAtMs here too, not just at clip-done.
          return updateClip(state, e.clipId, (c) =>
            withReadyStamp({ ...c, captionsDone: e.done, captionsTotal: e.total }, action.atMs),
          );
        case "transcript":
          return updateClip(state, e.clipId, (c) => ({ ...c, transcriptReceived: true }));
        case "clip-done":
          return updateClip(state, e.clipId, (c) =>
            withReadyStamp(
              {
                ...c,
                outcome: "done",
                durationS: e.dossier.durationS,
                metaKnown: true,
                decodeT: e.dossier.durationS, // the visual pass is complete by clip-done (mirrors use-perception-lab.ts's reducer)
                transcriptReceived: true,
                captionsTotal: c.captionsTotal || e.dossier.denseFrames.length,
                dossier: e.dossier,
              },
              action.atMs,
            ),
          );
        case "clip-error":
          if (e.cancelled) {
            // Only ever true for a cap-driven internal cancellation (the
            // public pipeline never exposes a user-facing "stop this clip"
            // action) — the clip is refused, not merely errored, so it's
            // dropped from state entirely rather than shown as an error row.
            return { clips: state.clips.filter((c) => c.id !== e.clipId) };
          }
          return updateClip(state, e.clipId, (c) => ({
            ...c,
            outcome: "error",
            errorMessage: e.message,
          }));
        default:
          return state;
      }
    }

    default:
      return state;
  }
}

/**
 * A clip becomes fully "ready" once its core dossier is done AND the
 * background caption pass has caught up (captionsTotal may still be 0 right
 * at clip-done if the caption count hasn't been reported yet — this stamps
 * readyAtMs once captions catch up, called by the hook's dense-captions
 * handling AFTER the reducer runs, since it depends on comparing the
 * POST-update done/total).
 */
export function withReadyStamp(clip: RawClipState, nowMs: number): RawClipState {
  if (clip.readyAtMs !== null) return clip;
  if (clip.outcome !== "done") return clip;
  if (clip.captionsTotal > 0 && clip.captionsDone < clip.captionsTotal) return clip;
  return { ...clip, readyAtMs: nowMs };
}

// ---------------------------------------------------------------------------
// Per-clip status projection (PublicClipStatus)
// ---------------------------------------------------------------------------

/** Mirrors clip-rollup.ts's derivedStatusOf heuristic: "analyzing" with zero signal yet is really "queued" (the visual pass is serialized). */
function hasStarted(clip: RawClipState): boolean {
  return clip.ingestProgress !== null || clip.decodeT > 0 || clip.metaKnown;
}

export function deriveClipStatus(clip: RawClipState): PublicClipStatus {
  if (clip.outcome === "error") {
    return { kind: "error", message: clip.errorMessage ?? "analysis failed", retryable: true };
  }
  if (clip.outcome === "analyzing" && !hasStarted(clip)) {
    return { kind: "queued" };
  }

  const pass =
    clip.ingestWindow && clip.ingestWindow.windows > 1
      ? { current: clip.ingestWindow.window, total: clip.ingestWindow.windows }
      : undefined;

  // Stage 1: watching your footage (ingest + decode/shot-scan).
  const visualDone = clip.metaKnown && clip.decodeT >= clip.durationS && clip.durationS > 0;
  if (!visualDone) {
    const progress =
      clip.ingestProgress !== null
        ? clip.ingestProgress * 0.5 // ingest is "half" of this stage's bar; decode is the other half
        : clip.durationS > 0
          ? 0.5 + 0.5 * Math.min(1, clip.decodeT / clip.durationS)
          : 0;
    return { kind: "analyzing", stageLabel: "watching your footage", progress, pass };
  }

  // Stage 2: listening for speech (whisper — single atomic event, no
  // incremental signal; see the module doc on why progress stays 0 here).
  if (!clip.transcriptReceived) {
    return { kind: "analyzing", stageLabel: "listening for speech", progress: 0, pass };
  }

  // Stage 3: describing what it sees (local caption pass — real incremental signal).
  if (clip.captionsTotal > 0 && clip.captionsDone < clip.captionsTotal) {
    return {
      kind: "analyzing",
      stageLabel: "describing what it sees",
      progress: clip.captionsDone / clip.captionsTotal,
      pass,
    };
  }

  if (clip.outcome === "done") return { kind: "ready" };
  // clip-done hasn't landed yet even though visual+speech+captions all read
  // complete (a brief race between events) — keep reporting the last stage.
  return { kind: "analyzing", stageLabel: "describing what it sees", progress: 1, pass };
}

export function toPublicClip(clip: RawClipState): PublicClip {
  return {
    id: clip.id,
    name: clip.fileName,
    durationS: clip.metaKnown ? clip.durationS : null,
    thumbnailUrl: clip.thumbnailUrl,
    status: deriveClipStatus(clip),
  };
}

export function deriveAllReady(clips: RawClipState[]): boolean {
  return clips.length > 0 && clips.every((c) => deriveClipStatus(c).kind === "ready");
}

// ---------------------------------------------------------------------------
// Batch ETA (blended end-to-end rate across clips finished this session)
// ---------------------------------------------------------------------------

export interface RateTracker {
  /** Σ durationS over clips that have reached "ready" this session. */
  totalSourceS: number;
  /** Σ (readyAtMs - addedAtMs) over the same clips, ms. */
  totalWallMs: number;
  /** Σ durationS over every clip whose meta is known (ready or not) — feeds the average-duration guess for still-queued clips. */
  totalKnownDurationS: number;
  clipsWithKnownDuration: number;
}

export const initialRateTracker: RateTracker = {
  totalSourceS: 0,
  totalWallMs: 0,
  totalKnownDurationS: 0,
  clipsWithKnownDuration: 0,
};

/** Rebuilds a RateTracker from the current clip list (called once per render — cheap, `clips.length` is bench-scale). */
export function buildRateTracker(clips: RawClipState[]): RateTracker {
  let totalSourceS = 0;
  let totalWallMs = 0;
  let totalKnownDurationS = 0;
  let clipsWithKnownDuration = 0;
  for (const c of clips) {
    if (c.metaKnown) {
      totalKnownDurationS += c.durationS;
      clipsWithKnownDuration += 1;
    }
    if (c.readyAtMs !== null) {
      totalSourceS += c.durationS;
      totalWallMs += Math.max(0, c.readyAtMs - c.addedAtMs);
    }
  }
  return { totalSourceS, totalWallMs, totalKnownDurationS, clipsWithKnownDuration };
}

/** Seconds remaining for one clip, or null when there's nothing to honestly estimate from yet. */
function estimateRemainingS(clip: RawClipState, rates: RateTracker, nowMs: number): number | null {
  // "Settled" means truly ready (readyAtMs set, which — see withReadyStamp —
  // waits for captions to catch up too) or errored out; a clip whose core
  // dossier is done but is still describing what it sees is NOT settled and
  // must keep contributing to the estimate.
  const settled = clip.readyAtMs !== null || clip.outcome === "error";
  if (settled) return 0;
  if (rates.totalSourceS <= 0) return null; // no clip has finished yet this session — nothing measured
  const wallMsPerSourceS = rates.totalWallMs / rates.totalSourceS;
  const assumedDurationS =
    clip.metaKnown && clip.durationS > 0
      ? clip.durationS
      : rates.clipsWithKnownDuration > 0
        ? rates.totalKnownDurationS / rates.clipsWithKnownDuration
        : null;
  if (assumedDurationS === null) return null;
  const totalEstimatedMs = assumedDurationS * wallMsPerSourceS;
  const elapsedMs = Math.max(0, nowMs - clip.addedAtMs);
  return Math.max(0, (totalEstimatedMs - elapsedMs) / 1000);
}

export interface BatchSummary {
  currentIndex: number;
  total: number;
  etaS: number | null;
}

/**
 * The bench's honest batch line — "Understanding your footage — clip 3 of
 * 12 · about 9 minutes left" is WS-D's copy around these numbers.
 * `currentIndex` counts settled clips (ready or error) + the one actively
 * being worked on (1-based), capped at `total`. `etaS` sums every
 * still-analyzing clip's estimate; null the moment ANY of them can't be
 * honestly estimated yet (rather than silently under-reporting).
 */
export function deriveBatch(clips: RawClipState[], nowMs: number): BatchSummary | null {
  if (clips.length === 0) return null;
  const rates = buildRateTracker(clips);
  const settled = clips.filter((c) => c.readyAtMs !== null || c.outcome === "error").length;
  // Nothing left analyzing → no batch line at all, so the bench switches to
  // its "All footage understood" summary instead of freezing on the last
  // "clip N of N · about a minute left" (the stale-header bug).
  if (settled >= clips.length) return null;
  const currentIndex = Math.min(clips.length, settled + 1);

  let etaS: number | null = 0;
  for (const clip of clips) {
    const remaining = estimateRemainingS(clip, rates, nowMs);
    if (remaining === null) {
      etaS = null;
      break;
    }
    etaS = (etaS ?? 0) + remaining;
  }

  return { currentIndex, total: clips.length, etaS };
}

// ---------------------------------------------------------------------------
// Model prep (first-ever-visit prefetch strip)
// ---------------------------------------------------------------------------

export type ModelKey = "embed" | "whisper" | "captioner";

/**
 * A model can download several constituent files (transformers.js loads a
 * config, tokenizer, weights, etc. separately) — `model-progress` events
 * report one file's [loaded,total] at a time, so this mirrors the lab's own
 * ModelStatus.files map (summed) rather than overwriting a single running
 * total, which would regress every time a NEW file within the same model
 * starts (see use-perception-lab.ts's ModelStatus for the precedent).
 */
export interface RawModelState {
  ready: boolean;
  files: Record<string, [loaded: number, total: number]>;
}

export const initialModelState: RawModelState = { ready: false, files: {} };

export type ModelTrackerState = Record<ModelKey, RawModelState>;

export const initialModelTrackerState: ModelTrackerState = {
  embed: { ...initialModelState, files: {} },
  whisper: { ...initialModelState, files: {} },
  captioner: { ...initialModelState, files: {} },
};

/** Folds one FunnelProgressEvent into model-tracking state; any other event kind is a no-op (same state reference back). */
export function applyModelEvent(
  state: ModelTrackerState,
  event: FunnelProgressEvent,
): ModelTrackerState {
  if (event.kind === "model-progress") {
    const m = state[event.model];
    if (m.ready) return state; // matches the lab: ready is sticky, stray late progress ignored
    return { ...state, [event.model]: { ...m, files: { ...m.files, [event.file]: [event.loaded, event.total] } } };
  }
  if (event.kind === "model-ready") {
    return { ...state, [event.model]: { ...state[event.model], ready: true } };
  }
  return state;
}

function modelBytes(m: RawModelState): { loaded: number; total: number } {
  let loaded = 0;
  let total = 0;
  for (const [l, t] of Object.values(m.files)) {
    loaded += l;
    total += t;
  }
  return { loaded, total };
}

/**
 * `null` once every tracked model is ready (types.ts: "null once warm, never
 * shown again"). While warming, progress is weighted evenly across all
 * THREE models (never just the ones that have reported something — a single
 * fully-loaded model must not read as progress:1 while the other two
 * haven't even started). A model that's ready but never reported bytes at
 * all (a Cache-API hit — nothing to download) still contributes its full
 * share, so a session that never had to download anything crosses to
 * done/null the moment the fast "ready" events land, without a fake 0->1
 * animation.
 */
export function deriveModelPrep(
  models: ModelTrackerState,
): { progress: number; done: boolean } | null {
  const all = Object.values(models);
  const done = all.every((m) => m.ready);
  if (done) return null;

  let weightedDone = 0;
  for (const m of all) {
    if (m.ready) {
      weightedDone += 1;
      continue;
    }
    const { loaded, total } = modelBytes(m);
    if (total > 0) weightedDone += loaded / total;
    // else: hasn't started reporting at all yet -> contributes 0
  }
  return { progress: all.length > 0 ? weightedDone / all.length : 0, done: false };
}

// ---------------------------------------------------------------------------
// Footage cap
// ---------------------------------------------------------------------------

export interface FootageCapCheck {
  /** How many of the incoming files the maxClips cap allows (0..incomingCount). */
  allowedCount: number;
  refusedByMaxClips: number;
}

/** Pure clip-count check, synchronous at drop time (see PublicPipeline.lastRefusal's "maxClips" reason). */
export function checkMaxClipsCap(
  existingCount: number,
  incomingCount: number,
  cap: FootageCap,
): FootageCapCheck {
  const room = Math.max(0, cap.maxClips - existingCount);
  const allowedCount = Math.min(room, incomingCount);
  return { allowedCount, refusedByMaxClips: incomingCount - allowedCount };
}

/**
 * Retroactive check applied as each clip's real duration becomes known (see
 * PublicPipeline.lastRefusal's "maxTotalSeconds" reason) — duration can't be
 * known synchronously at drop time, only once the funnel decodes far enough
 * to report `meta`.
 */
export function wouldExceedMaxTotalSeconds(
  knownTotalSExcludingThisClip: number,
  thisClipDurationS: number,
  cap: FootageCap,
): boolean {
  return knownTotalSExcludingThisClip + thisClipDurationS > cap.maxTotalSeconds;
}

/** Σ durationS over every OTHER already-known-duration clip (the retroactive check's "excluding this one" input). */
export function knownTotalSeconds(clips: RawClipState[], excludingId: string): number {
  let total = 0;
  for (const c of clips) {
    if (c.id !== excludingId && c.metaKnown) total += c.durationS;
  }
  return total;
}
