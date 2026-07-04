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
  type PromptSources,
  type Storyboard,
} from "@openreel/core";

const EXP_PREFIX = "director-exp:";
const VIDEO_PREFIX = "director-exp-video:";
const INDEX_KEY = "director-exp:index";
/** Keep the most recent N experiments (each can be a few hundred KB of text). */
const MAX_EXPERIMENTS = 200;

export interface ExperimentClipRef {
  /** Session-scoped id used inside messages/storyboard items. */
  clipId: string;
  /** Stable identity: perception:vN:name:size:mtime. */
  cacheKey: string;
  fileName: string;
}

export interface DirectorExperiment {
  id: string;
  /** Run start / last update, epoch ms. */
  at: number;
  updatedAt: number;
  brief: string;
  targetDurationS: number | null;
  promptSources: PromptSources;
  model: string;
  clips: ExperimentClipRef[];
  /** Verbatim conversation (system prompt, dossiers, tool traffic, replies). */
  messages: ChatMessage[];
  activity: DirectorActivity[];
  storyboard: Storyboard | null;
  warnings: string[];
  usage: { promptTokens: number; completionTokens: number; calls: number };
  /** Total LLM wall-clock across the conversation so far. */
  durationMs: number;
}

export interface ExperimentSummary {
  id: string;
  at: number;
  updatedAt: number;
  brief: string;
  title: string | null;
  itemCount: number;
  model: string;
  promptSources: PromptSources;
  targetDurationS?: number | null;
  /** Set when a rendered debug video is stored for this experiment. */
  videoAt?: number;
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
  return {
    id: exp.id,
    at: exp.at,
    updatedAt: exp.updatedAt,
    brief: exp.brief,
    title: exp.storyboard?.title ?? null,
    itemCount: exp.storyboard?.items.length ?? 0,
    model: exp.model,
    promptSources: exp.promptSources,
    targetDurationS: exp.targetDurationS,
    videoAt: prev?.videoAt,
  };
}

export async function listExperiments(): Promise<ExperimentSummary[]> {
  try {
    const record = await storage.loadCache(INDEX_KEY);
    if (!record) return [];
    return fromBuffer<ExperimentSummary[]>(record.data);
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
