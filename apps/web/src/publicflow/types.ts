/**
 * publicflow — the seam between the wizz.video public UI (WS-D, publicapp/)
 * and the pipeline/director engine glue (WS-E, this directory). WS-D imports
 * ONLY from this directory + @wizz/contracts + services/gateway.ts; WS-E
 * implements against these shapes. Interface changes require orchestrator
 * sign-off (the zero-redo contract pattern).
 *
 * Bundle rule: nothing imported (non-type) from pages/lab/ may leak the
 * public-bundle grep markers ("PerceptionLab", "openreel:lab-settings",
 * "SelectorTuning") into dist-public — verify with build:public + grep after
 * any import change.
 */
import type { PublishedPreset, FootageCap, TelemetryType } from "@wizz/contracts";

/** One dropped clip's public-facing lifecycle. Stage names are UI copy, human words. */
export type PublicClipStatus =
  | { kind: "queued" }
  | {
      kind: "analyzing";
      /** "watching your footage" | "listening for speech" | "describing what it sees" */
      stageLabel: string;
      /** 0..1 within the current stage */
      progress: number;
      /** Rolling-window long clips: "analyzing in 3 passes" — pass i of n when known. */
      pass?: { current: number; total: number };
    }
  | { kind: "ready" }
  | { kind: "error"; message: string; retryable: boolean };

export interface PublicClip {
  id: string;
  name: string;
  durationS: number | null; // null until decoded
  thumbnailUrl: string | null;
  status: PublicClipStatus;
  /** True when this clip's analysis replaced a cached dossier invalidated by a pipeline update — absent/false for an ordinary first analysis. */
  reanalyzing?: boolean;
}

/** The bench's engine surface (WS-E fills; WS-D renders). */
export interface PublicPipeline {
  clips: PublicClip[];
  addFiles(files: File[]): void;
  removeClip(id: string): void;
  retryClip(id: string): void;
  /** True when ≥1 clip and every clip is ready (Generate arms). */
  allReady: boolean;
  /** Honest batch line: "Understanding your footage — clip 3 of 12 · about 9 minutes left". */
  batch: {
    currentIndex: number;
    total: number;
    etaS: number | null;
    /** True when ≥1 still-analyzing clip's cache was invalidated by a pipeline update — fmtBatchLine swaps in "Updating" copy; absent/false otherwise. */
    reanalyzing?: boolean;
  } | null;
  /** Cloud speech transcription toggle (session-scoped consent; preset provides the default). */
  cloudSTT: boolean;
  setCloudSTT(on: boolean): void;
  /** First-ever visit model prefetch strip: null once warm (never shown again). */
  modelPrep: { progress: number; done: boolean } | null;
  /** Footage cap enforcement (from the preset fetch): refusals surface as UI copy. */
  cap: FootageCap;
  /** Clips refused by the cap on the last add, for the friendly explainer. */
  lastRefusal: { reason: "maxClips" | "maxTotalSeconds"; count: number } | null;
}

/** What the user chose on the bench (the public product's ENTIRE settings surface). */
export interface CutRequest {
  styleId: string | null; // null = director's choice
  brief: string; // may be ""
  targetS: number;
  music: boolean;
}

export type DirectorPhase =
  | { kind: "idle" }
  | {
      kind: "running";
      /** Narrative lines, oldest first; search queries verbatim, wrapped in quotes by the engine. */
      activity: { text: string; isQuery: boolean }[];
    }
  | { kind: "done"; cut: PublicCut }
  | { kind: "error"; code: string; friendly: string; retryable: boolean };

export interface PublicCutSegment {
  clipId: string;
  inS: number;
  outS: number;
  /** The director's one-line "why" for this pick (hover/focus card). */
  why: string;
  thumbnailUrl: string | null;
}

export interface PublicCut {
  /** Director-written film title ("Golden Hour, Mostly"). */
  title: string;
  totalS: number;
  segments: PublicCutSegment[];
  clipCount: number;
  /** Two composed variations when music was on; null otherwise. */
  musicTakes: { a: string; b: string } | null; // object URLs / proxied URLs
  /** True from cut assembly until the music request settles (ready or silently given up); absent/false when music was never requested. */
  musicPending?: boolean;
}

/** The director surface (WS-E fills): one active conversation, refine continues it. */
export interface PublicDirector {
  phase: DirectorPhase;
  generate(request: CutRequest): void;
  /** Continues the SAME conversation; replaces the current cut. */
  refine(instruction: string): void;
  cancel(): void;
  /** Back-to-bench regenerate: drops the conversation, keeps footage. */
  reset(): void;
}

/** Validated runtime config derived from the active PublishedPreset. */
export interface PublicRunConfig {
  preset: PublishedPreset;
  /** LabSettings-shaped bundle already passed through migrateLabSettings. */
  labSettings: unknown;
  /** Style chips to render, resolved against core STYLE_PRESETS (order = whitelist). */
  styles: { id: string; label: string; tagline: string }[];
  durationChips: number[];
  allowCustomDuration: boolean;
  minTargetS: number;
  maxTargetS: number;
  musicEnabled: boolean;
  cloudSTTDefaultOn: boolean;
  cap: FootageCap;
}

/** Fire-and-forget telemetry hook points WS-D calls at state transitions. */
export type TrackFn = (type: TelemetryType, data?: Record<string, string | number | boolean | null>) => void;
