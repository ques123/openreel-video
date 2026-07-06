/**
 * Director experiment persistence: every run's settings, the verbatim LLM
 * conversation, activity log, and resulting storyboard, saved to IndexedDB so
 * experiments are never lost. Clips are referenced by dossier cacheKey (the
 * stable cross-session identity) so a stored storyboard can be re-watched or
 * exported in a later session once the same files are re-added.
 */

import {
  StorageEngine,
  type ChatMessage,
  type DirectorActivity,
  type DurationViolation,
  type MusicBrief,
  type PromptSources,
  type SelectorConfig,
  type Storyboard,
  type StoryboardMetrics,
} from "@openreel/core";
import { estimateCostUSD, fmtUSD } from "./model-pricing";
import type { ModelChatUsage } from "./openai-proxy";
import type { SunoTrack } from "./suno";

const EXP_PREFIX = "director-exp:";
const VIDEO_PREFIX = "director-exp-video:";
const INDEX_KEY = "director-exp:index";
/** Keep the most recent N experiments (each can be a few hundred KB of text). */
export const MAX_EXPERIMENTS = 200;
/** Start warning this close to the cap (saves past the cap evict permanently). */
export const EXPERIMENT_CAP_WARN_AT = 190;

/**
 * Human-readable near-cap warning for the experiments list, or null while
 * comfortably under the cap. Surfaced because eviction is otherwise silent
 * AND destructive: the save that lands past MAX_EXPERIMENTS permanently
 * deletes the oldest run and its rendered video (see saveExperiment).
 */
export function evictionWarning(count: number): string | null {
  if (count < EXPERIMENT_CAP_WARN_AT) return null;
  return (
    `${count}/${MAX_EXPERIMENTS} stored — ` +
    (count >= MAX_EXPERIMENTS
      ? "every new run permanently deletes the oldest run and its rendered video."
      : "oldest runs (and their rendered videos) are permanently deleted on save once the cap is hit.") +
    " Export anything you want to keep."
  );
}

/**
 * Case-insensitive substring filter shared by the experiment pickers
 * (Experiments panel, matrix run picker): matches brief, storyboard title,
 * director model, caption models and brief angle. Blank query matches all.
 */
export function matchesExperimentFilter(
  s: {
    brief: string;
    title?: string | null;
    model: string;
    captionModels?: string;
    briefAngle?: string;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.brief, s.title ?? "", s.model, s.captionModels ?? "", s.briefAngle ?? ""].some(
    (field) => field.toLowerCase().includes(q),
  );
}

export interface ExperimentClipRef {
  /** Session-scoped id used inside messages/storyboard items. */
  clipId: string;
  /** Stable identity: perception:vN:name:size:mtime. */
  cacheKey: string;
  fileName: string;
}

/**
 * Aggregate captioning cost/time across the run's clips, over only the
 * caption sources actually enabled in promptSources (mirrors the
 * captionModels resolution in use-director's start()). Optional everywhere —
 * legacy experiments predate this field.
 */
export interface ExperimentCaptionStats {
  cloudFrames: number;
  cloudPromptTokens: number;
  cloudCompletionTokens: number;
  cloudMs: number;
  localFrames: number;
  localMs: number;
  /**
   * Per-model token split (key = resolved CloudRunMeta.model), needed because
   * captionModels can name TWO differently-priced models (e.g.
   * "gpt-5.2+gpt-5.4-mini") whose cost can't be recovered from the aggregate
   * totals above. Absent on legacy/backfilled records — see
   * experimentCaptionCostUSD for the single-model fallback used then.
   */
  byModel?: Record<string, { promptTokens: number; completionTokens: number }>;
}

export interface DirectorExperiment {
  id: string;
  /** Run start / last update, epoch ms. */
  at: number;
  updatedAt: number;
  brief: string;
  /** Label of the suggested angle the brief was seeded from, if any (see brief-suggestions.ts). */
  briefAngle?: string;
  /** Curated style preset id chosen for this run, if any (see style-presets.ts). */
  styleId?: string;
  targetDurationS: number | null;
  promptSources: PromptSources;
  model: string;
  /** Cloud caption model(s) behind the timelines the director consumed ("" = local only). */
  captionModels: string;
  /**
   * Effective signal-stack selector config for this run (tuned settings +
   * any active style-preset adjustment — see signal-score.ts
   * selectorConfigForPreset): what selectCandidates ran with for a
   * "candidates" promptMode run, recorded regardless of promptMode so any
   * run that also used candidates-only enhance stays comparable. Absent on
   * records saved before the selector tuning UI shipped.
   */
  selectorConfig?: SelectorConfig;
  clips: ExperimentClipRef[];
  /** Verbatim conversation (system prompt, dossiers, tool traffic, replies). */
  messages: ChatMessage[];
  activity: DirectorActivity[];
  storyboard: Storyboard | null;
  warnings: string[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    calls: number;
    /** Prompt tokens served from provider cache (subset of promptTokens). */
    cachedTokens?: number;
  };
  /** Total LLM wall-clock across the conversation so far. */
  durationMs: number;
  /** Zero-inference quality metrics of the accepted storyboard (see computeStoryboardMetrics). */
  metrics?: StoryboardMetrics;
  /** Set when the accepted cut missed the ±10% duration target (see DirectorLoopResult). */
  durationViolation?: DurationViolation | null;
  /** Usage of auxiliary LLM calls billed to this run (brief suggestions, music brief). */
  auxUsage?: ModelChatUsage[];
  /** Captioning cost/time behind the run's active sources; absent = never computed (legacy). */
  captionStats?: ExperimentCaptionStats;
  /**
   * Contextual background-music session for this run's storyboard — absent
   * when the music toggle was off (or hasn't produced anything yet).
   * committedTrackId names which of the (usually two) A/B'd tracks the user
   * picked to bake into the debug render; null = generated but not chosen.
   */
  music?: {
    brief: MusicBrief;
    taskId: string;
    tracks: SunoTrack[];
    committedTrackId: string | null;
    /** Usage of the LLM call that wrote the brief; absent = heuristic fallback/legacy. */
    usage?: ModelChatUsage;
  };
}

export interface ExperimentSummary {
  id: string;
  at: number;
  updatedAt: number;
  brief: string;
  briefAngle?: string;
  styleId?: string;
  title: string | null;
  itemCount: number;
  model: string;
  captionModels?: string;
  promptSources: PromptSources;
  targetDurationS?: number | null;
  /** Effective selector config for this run — see DirectorExperiment.selectorConfig. */
  selectorConfig?: SelectorConfig;
  /** Set when a rendered debug video is stored for this experiment. */
  videoAt?: number;
  /** Director LLM token totals, for the at-a-glance menu row. */
  promptTokens?: number;
  completionTokens?: number;
  /** Prompt tokens served from provider cache (subset of promptTokens). */
  cachedTokens?: number;
  /** Auxiliary LLM usage billed to the run (brief suggestions, music brief). */
  auxUsage?: ModelChatUsage[];
  /** Total LLM wall-clock across the conversation so far. */
  durationMs?: number;
  /** Captioning cost/time behind the run's active sources. */
  captionStats?: ExperimentCaptionStats;
}

/** 4500 -> "4.5k", 331000 -> "331k", 900 -> "900". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}

/** 595000 -> "9m55s", 45000 -> "45s". */
export function fmtDurationMs(ms: number): string {
  const totalS = Math.round(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/**
 * Approximate USD cost of a run's captioning, or null when it can't be
 * priced. Preferred path: sum estimateCostUSD per byModel entry (handles two
 * differently-priced models in one run). Legacy/backfilled records lack
 * byModel — those only get priced when captionModels names exactly ONE
 * known cloud model, since the aggregate cloud token totals can't be safely
 * split across two different prices. Shared here so every UI spot (menu,
 * detail, matrix, compare-grid picker) agrees on the same number.
 */
export function experimentCaptionCostUSD(s: {
  captionModels?: string;
  captionStats?: ExperimentCaptionStats;
}): number | null {
  const stats = s.captionStats;
  if (!stats) return null;
  if (stats.byModel && Object.keys(stats.byModel).length > 0) {
    let total = 0;
    let any = false;
    for (const [model, tok] of Object.entries(stats.byModel)) {
      const cost = estimateCostUSD(model, tok.promptTokens, tok.completionTokens);
      if (cost !== null) {
        total += cost;
        any = true;
      }
    }
    return any ? total : null;
  }
  const models = (s.captionModels ?? "").split("+").filter(Boolean);
  if (models.length === 1 && models[0] !== "local-only") {
    return estimateCostUSD(models[0], stats.cloudPromptTokens, stats.cloudCompletionTokens);
  }
  return null;
}

/**
 * All auxiliary LLM usage billed to a run — the recorded auxUsage list plus
 * the music-brief call (stored on music.usage) — flattened into one list so
 * summaries and cost lines account for every call the run made.
 */
export function experimentAuxUsage(exp: {
  auxUsage?: ModelChatUsage[];
  music?: { usage?: ModelChatUsage };
}): ModelChatUsage[] {
  return [...(exp.auxUsage ?? []), ...(exp.music?.usage ? [exp.music.usage] : [])];
}

/**
 * Summed USD cost of auxiliary calls; null when none is priceable (same
 * never-guess semantics as experimentCaptionCostUSD).
 */
export function experimentAuxCostUSD(aux: ModelChatUsage[]): number | null {
  let total = 0;
  let any = false;
  for (const u of aux) {
    const cost = estimateCostUSD(u.model, u.promptTokens, u.completionTokens, u.cachedTokens);
    if (cost !== null) {
      total += cost;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Compact "director model · tokens (cached) ≈$ · gen time · caption models ·
 * caption tokens ≈$ · cap time · aux tokens ≈$" line; omits missing/
 * unpriceable pieces (legacy records — durationMs in particular predates some
 * runs, so it's dropped silently rather than showing "gen 0s"). Both
 * durations are labeled ("gen" for the director's LLM wall-clock, "cap" for
 * captioning) since the line carries two independent timings once both are
 * present. cachedTokens (when recorded) both discounts the director ≈$ and is
 * shown inline so cache effectiveness is visible per run; aux covers the
 * side calls (brief suggestions, music brief) so the line is the run's total.
 */
export function experimentCostLine(s: {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  durationMs?: number;
  captionModels?: string;
  captionStats?: ExperimentCaptionStats;
  auxUsage?: ModelChatUsage[];
}): string | null {
  const parts: string[] = [];
  if (s.model) parts.push(s.model);
  const directorTok = (s.promptTokens ?? 0) + (s.completionTokens ?? 0);
  if (directorTok > 0) {
    const cached = s.cachedTokens ?? 0;
    const dirCost = estimateCostUSD(s.model, s.promptTokens ?? 0, s.completionTokens ?? 0, cached);
    parts.push(
      `${fmtTokens(directorTok)} tok` +
        (cached > 0 ? ` (${fmtTokens(cached)} cached)` : "") +
        (dirCost !== null ? ` ≈${fmtUSD(dirCost)}` : ""),
    );
  }
  if (s.durationMs) parts.push(`gen ${fmtDurationMs(s.durationMs)}`);
  if (s.captionModels) parts.push(s.captionModels);
  const stats = s.captionStats;
  if (stats) {
    const capTok = stats.cloudPromptTokens + stats.cloudCompletionTokens;
    if (capTok > 0) {
      const capCost = experimentCaptionCostUSD(s);
      parts.push(`cap ${fmtTokens(capTok)} tok${capCost !== null ? ` ≈${fmtUSD(capCost)}` : ""}`);
    }
    const capMs = stats.cloudMs + stats.localMs;
    if (capMs > 0) parts.push(`cap ${fmtDurationMs(capMs)}`);
  }
  const aux = s.auxUsage ?? [];
  const auxTok = aux.reduce((sum, u) => sum + u.promptTokens + u.completionTokens, 0);
  if (auxTok > 0) {
    const auxCost = experimentAuxCostUSD(aux);
    parts.push(`aux ${fmtTokens(auxTok)} tok${auxCost !== null ? ` ≈${fmtUSD(auxCost)}` : ""}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

const storage = new StorageEngine();

function toBuffer(value: unknown): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

function fromBuffer<T>(data: ArrayBuffer): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

function summarize(exp: DirectorExperiment, prev?: ExperimentSummary): ExperimentSummary {
  const aux = experimentAuxUsage(exp);
  return {
    id: exp.id,
    at: exp.at,
    updatedAt: exp.updatedAt,
    brief: exp.brief,
    briefAngle: exp.briefAngle,
    styleId: exp.styleId,
    title: exp.storyboard?.title ?? null,
    itemCount: exp.storyboard?.items.length ?? 0,
    model: exp.model,
    captionModels: exp.captionModels,
    promptSources: exp.promptSources,
    targetDurationS: exp.targetDurationS,
    selectorConfig: exp.selectorConfig,
    videoAt: prev?.videoAt,
    promptTokens: exp.usage.promptTokens,
    completionTokens: exp.usage.completionTokens,
    // Absent-key convention (matches briefAngle/styleId): legacy records
    // without cache/aux tracking keep their shape unchanged in the index.
    ...(exp.usage.cachedTokens !== undefined ? { cachedTokens: exp.usage.cachedTokens } : {}),
    ...(aux.length > 0 ? { auxUsage: aux } : {}),
    durationMs: exp.durationMs,
    captionStats: exp.captionStats,
  };
}

/**
 * One-time lazy backfill: entries written before promptTokens/completionTokens/
 * durationMs/captionStats existed lack `promptTokens`. Fill them in from the
 * full record when possible; leave untouched (and try again next call) if the
 * full record is missing or unreadable. Mutates `index` in place and returns
 * whether anything changed, so the caller can persist once.
 */
async function backfillIndex(index: ExperimentSummary[]): Promise<boolean> {
  let changed = false;
  for (const entry of index) {
    if (entry.promptTokens !== undefined) continue;
    const full = await loadExperiment(entry.id);
    if (!full) continue;
    entry.promptTokens = full.usage.promptTokens;
    entry.completionTokens = full.usage.completionTokens;
    if (full.usage.cachedTokens !== undefined) entry.cachedTokens = full.usage.cachedTokens;
    const aux = experimentAuxUsage(full);
    if (aux.length > 0) entry.auxUsage = aux;
    entry.durationMs = full.durationMs;
    if (full.captionStats) entry.captionStats = full.captionStats;
    changed = true;
  }
  return changed;
}

export async function listExperiments(): Promise<ExperimentSummary[]> {
  try {
    const record = await storage.loadCache(INDEX_KEY);
    if (!record) return [];
    const index = fromBuffer<ExperimentSummary[]>(record.data);
    if (await backfillIndex(index)) await writeIndex(index);
    return index;
  } catch {
    return [];
  }
}

export async function loadExperiment(id: string): Promise<DirectorExperiment | null> {
  try {
    const record = await storage.loadCache(EXP_PREFIX + id);
    if (!record) return null;
    return fromBuffer<DirectorExperiment>(record.data);
  } catch {
    return null;
  }
}

/** Insert-or-update; the index stays newest-first and bounded. */
export async function saveExperiment(exp: DirectorExperiment): Promise<void> {
  const data = toBuffer(exp);
  await storage.saveCache({
    key: EXP_PREFIX + exp.id,
    data,
    timestamp: Date.now(),
    size: data.byteLength,
  });
  const index = await listExperiments();
  const prev = index.find((e) => e.id === exp.id);
  const next = [summarize(exp, prev), ...index.filter((e) => e.id !== exp.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const kept = next.slice(0, MAX_EXPERIMENTS);
  for (const dropped of next.slice(MAX_EXPERIMENTS)) {
    await storage.deleteCache(EXP_PREFIX + dropped.id).catch(() => undefined);
    await storage.deleteCache(VIDEO_PREFIX + dropped.id).catch(() => undefined);
  }
  const indexData = toBuffer(kept);
  await storage.saveCache({
    key: INDEX_KEY,
    data: indexData,
    timestamp: Date.now(),
    size: indexData.byteLength,
  });
}

async function writeIndex(index: ExperimentSummary[]): Promise<void> {
  const data = toBuffer(index);
  await storage.saveCache({
    key: INDEX_KEY,
    data,
    timestamp: Date.now(),
    size: data.byteLength,
  });
}

/** Store the rendered debug video so comparisons replay without re-rendering. */
export async function saveExperimentVideo(id: string, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer();
  await storage.saveCache({
    key: VIDEO_PREFIX + id,
    data,
    timestamp: Date.now(),
    size: data.byteLength,
  });
  const index = await listExperiments();
  const entry = index.find((e) => e.id === id);
  if (entry) {
    entry.videoAt = Date.now();
    await writeIndex(index);
  }
}

export async function loadExperimentVideo(id: string): Promise<Blob | null> {
  try {
    const record = await storage.loadCache(VIDEO_PREFIX + id);
    if (!record) return null;
    return new Blob([record.data], { type: "video/webm" });
  } catch {
    return null;
  }
}

export async function deleteExperiment(id: string): Promise<void> {
  await storage.deleteCache(EXP_PREFIX + id).catch(() => undefined);
  await storage.deleteCache(VIDEO_PREFIX + id).catch(() => undefined);
  const index = await listExperiments();
  const kept = index.filter((e) => e.id !== id);
  const indexData = toBuffer(kept);
  await storage.saveCache({
    key: INDEX_KEY,
    data: indexData,
    timestamp: Date.now(),
    size: indexData.byteLength,
  });
}

/** Delete EVERY stored experiment record, rendered video and the index. */
export async function deleteAllExperiments(): Promise<void> {
  const index = await listExperiments();
  for (const e of index) {
    await storage.deleteCache(EXP_PREFIX + e.id).catch(() => undefined);
    await storage.deleteCache(VIDEO_PREFIX + e.id).catch(() => undefined);
  }
  await storage.deleteCache(INDEX_KEY).catch(() => undefined);
}

/**
 * Delete every rendered experiment video while keeping the runs themselves
 * (a stored run re-renders on demand from its storyboard + source files).
 * Clears the index's videoAt markers so the UI stops advertising renders.
 */
export async function deleteAllExperimentVideos(): Promise<void> {
  const index = await listExperiments();
  for (const e of index) {
    // Unconditional: legacy entries may hold a video without a videoAt flag.
    await storage.deleteCache(VIDEO_PREFIX + e.id).catch(() => undefined);
    delete e.videoAt;
  }
  await writeIndex(index);
}

/**
 * Portable JSON export of experiment records — the escape hatch for the
 * MAX_EXPERIMENTS eviction cap. Contains everything persisted per run
 * (settings, verbatim conversation, activity log, storyboard, usage/cost).
 * Rendered debug videos are deliberately NOT included: they are large binary
 * blobs; re-render from the storyboard + source files instead.
 */
export interface ExperimentsExport {
  kind: "openreel-director-experiments";
  version: 1;
  exportedAt: number;
  /** What the export deliberately leaves out (rendered videos). */
  excludes: string;
  experiments: DirectorExperiment[];
}

export function buildExperimentsExport(experiments: DirectorExperiment[]): ExperimentsExport {
  return {
    kind: "openreel-director-experiments",
    version: 1,
    exportedAt: Date.now(),
    excludes:
      "rendered debug videos (large binaries) — re-render from storyboard + source files",
    experiments,
  };
}

/**
 * Load full records for `ids` (default: every indexed experiment) and build
 * the export payload. Unreadable records are skipped silently — an export
 * that saves 199 of 200 runs beats one that fails outright.
 */
export async function collectExperimentsExport(ids?: string[]): Promise<ExperimentsExport> {
  const targetIds = ids ?? (await listExperiments()).map((e) => e.id);
  const experiments: DirectorExperiment[] = [];
  for (const id of targetIds) {
    const exp = await loadExperiment(id);
    if (exp) experiments.push(exp);
  }
  return buildExperimentsExport(experiments);
}
