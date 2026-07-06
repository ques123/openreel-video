/**
 * Dossier persistence: serialize a ClipDossier to a single ArrayBuffer
 * (StorageEngine CacheRecord.data) and back. Embeddings are stored as
 * base64-encoded Float32Array bytes inside the JSON payload.
 */

import { StorageEngine } from "../storage/storage-engine";
import { DOSSIER_VERSION, type ClipDossier, type Shot } from "./types";

const KEY_PREFIX = `perception:v${DOSSIER_VERSION}`;

export function dossierCacheKey(file: File): string {
  return `${KEY_PREFIX}:${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * The cache keys this file's dossier would live under for every OLDER
 * DOSSIER_VERSION, newest first. The version is baked into the key, so after
 * a bump a plain load() misses without ever seeing the old record — these
 * keys are how "cached but version-invalidated" is told apart from "brand
 * new clip". Pure; exported for unit tests.
 */
export function staleDossierCacheKeys(
  file: File,
): Array<{ version: number; key: string }> {
  const keys: Array<{ version: number; key: string }> = [];
  for (let v = DOSSIER_VERSION - 1; v >= 1; v -= 1) {
    keys.push({
      version: v,
      key: `perception:v${v}:${file.name}:${file.size}:${file.lastModified}`,
    });
  }
  return keys;
}

interface SerializedShot extends Omit<Shot, "embedding" | "frameEmbeddings"> {
  embeddingB64: string | null;
  frameEmbeddingsB64: string[];
}

interface SerializedDossier extends Omit<ClipDossier, "shots"> {
  shots: SerializedShot[];
}

function float32ToB64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function b64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function serializeDossier(dossier: ClipDossier): ArrayBuffer {
  const serialized: SerializedDossier = {
    ...dossier,
    shots: dossier.shots.map((shot) => {
      const { embedding, frameEmbeddings, ...rest } = shot;
      return {
        ...rest,
        embeddingB64: embedding ? float32ToB64(embedding) : null,
        frameEmbeddingsB64: (frameEmbeddings ?? []).map(float32ToB64),
      };
    }),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(serialized));
  // Ensure a standalone ArrayBuffer (not a view over a larger one).
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

export function deserializeDossier(data: ArrayBuffer): ClipDossier {
  const parsed = JSON.parse(new TextDecoder().decode(data)) as SerializedDossier;
  // Migrate pre-split records (single cloudVision marker, no per-scope
  // stores): a shots-scope enhance lived only on shot.cloudCaption, and run
  // stats were untracked (zeros).
  const legacy = parsed.cloudVision ?? null;
  const cloudShotCaptions =
    parsed.cloudShotCaptions ??
    (legacy?.scope === "shots"
      ? parsed.shots
          .filter((s) => s.cloudCaption)
          .map((s) => ({ t: s.repFrameTime, text: s.cloudCaption! }))
      : []);
  const legacyRun = (count: number) =>
    legacy
      ? {
          model: legacy.model,
          enhancedAt: legacy.enhancedAt,
          framesSent: count,
          framesFailed: 0,
          ms: 0,
          promptTokens: 0,
          completionTokens: 0,
        }
      : null;
  const cloudRuns = parsed.cloudRuns ?? {
    shots: legacy?.scope === "shots" ? legacyRun(cloudShotCaptions.length) : null,
    timeline:
      legacy?.scope === "timeline"
        ? legacyRun((parsed.cloudDenseCaptions ?? []).length)
        : null,
  };
  return {
    ...parsed,
    denseFrames: parsed.denseFrames ?? [],
    denseCaptions: parsed.denseCaptions ?? [],
    cloudDenseCaptions: parsed.cloudDenseCaptions ?? [],
    cloudShotCaptions,
    cloudRuns,
    cloudRunArchive:
      parsed.cloudRunArchive ??
      // Pre-archive records: reconstruct entries from the active stores.
      ([
        cloudRuns.shots
          ? { scope: "shots" as const, model: cloudRuns.shots.model, captions: cloudShotCaptions, meta: cloudRuns.shots }
          : null,
        cloudRuns.timeline
          ? { scope: "timeline" as const, model: cloudRuns.timeline.model, captions: parsed.cloudDenseCaptions ?? [], meta: cloudRuns.timeline }
          : null,
      ].filter(Boolean) as ClipDossier["cloudRunArchive"]),
    cloudVision: legacy,
    localCaptionPerf: parsed.localCaptionPerf ?? null,
    // Audio signals: undefined = never computed (a pre-audio-signals cache,
    // or a dossier saved before its envelope pass landed) — this is exactly
    // the state FunnelOrchestrator.enrichAudioSignals() targets with a
    // background envelopeOnly whisper pass. null means the pass ran and
    // found no audio track. Passed through as-is rather than defaulted to
    // null: collapsing "never computed" into "computed, no audio" would
    // stop old caches from ever enriching.
    audioEnvelope: parsed.audioEnvelope,
    audioEvents: parsed.audioEvents,
    shots: parsed.shots.map((shot) => {
      const { embeddingB64, frameEmbeddingsB64, ...rest } = shot;
      return {
        ...rest,
        embedding: embeddingB64 ? b64ToFloat32(embeddingB64) : null,
        frameEmbeddings: (frameEmbeddingsB64 ?? []).map(b64ToFloat32),
        // Pre-caption caches lack the field; the orchestrator enriches lazily.
        caption: rest.caption ?? null,
        cloudCaption: rest.cloudCaption ?? null,
      };
    }),
  };
}

/**
 * Coalescing, wall-clock-throttled scheduler for one dossier's incremental
 * saves. Saving re-serializes the WHOLE dossier (every dense-frame JPEG), so
 * the caption pass must not await a full write every few frames:
 *
 *  - request() is fire-and-forget. It starts a save only when none is in
 *    flight AND at least minIntervalMs passed since the last one started;
 *    otherwise it's dropped. Dropping is safe because the dossier is mutated
 *    in place — any later save (or the final flush) persists this state too,
 *    so a crash loses at most minIntervalMs of captions.
 *  - flush() awaits the in-flight save (if any), then runs one final,
 *    unconditional save — call it on completion so nothing is ever lost.
 *
 * Save errors are swallowed (incremental persistence is best-effort, same
 * as the `.catch(() => undefined)` the call sites always used).
 */
export class ThrottledDossierSaver {
  private inFlight: Promise<void> | null = null;
  private lastStartMs = -Infinity;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly minIntervalMs: number = 10_000,
    /** Injectable clock (tests). */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Fire-and-forget: save unless one is in flight or too recent. */
  request(): void {
    if (this.inFlight) return;
    if (this.now() - this.lastStartMs < this.minIntervalMs) return;
    void this.begin();
  }

  /** Await any in-flight save, then run one final unconditional save. */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    await this.begin();
  }

  private begin(): Promise<void> {
    this.lastStartMs = this.now();
    const done = this.save()
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight === done) this.inFlight = null;
      });
    this.inFlight = done;
    return done;
  }
}

export class DossierCache {
  constructor(private readonly storage: StorageEngine = new StorageEngine()) {}

  async load(file: File): Promise<ClipDossier | null> {
    try {
      const record = await this.storage.loadCache(dossierCacheKey(file));
      if (!record) return null;
      const dossier = deserializeDossier(record.data);
      if (dossier.version !== DOSSIER_VERSION) return null;
      // Backfill for dossiers cached before recordedAt existed — the mtime is
      // part of the cache key, so it is the same value analysis would store.
      // cacheKey is recomputed (older saves left it empty).
      return {
        ...dossier,
        recordedAt: dossier.recordedAt ?? file.lastModified,
        cacheKey: dossierCacheKey(file),
      };
    } catch {
      return null;
    }
  }

  /**
   * The newest OLD-version dossier cached for this file, or null when none
   * exists (a genuinely new clip). Only the version number is reported —
   * the stale record's schema is arbitrary, so its data is never
   * deserialized. The record itself is left in place (the storage panel's
   * clear tools own cache eviction).
   */
  async findStaleVersion(file: File): Promise<number | null> {
    for (const { version, key } of staleDossierCacheKeys(file)) {
      try {
        if (await this.storage.loadCache(key)) return version;
      } catch {
        // Unreadable record = treat as absent; this is best-effort labeling.
      }
    }
    return null;
  }

  async save(file: File, dossier: ClipDossier): Promise<void> {
    // The stable identity used to re-find this clip across sessions
    // (clipIds are per-session; experiments and Stage 6 remap through this).
    dossier.cacheKey = dossierCacheKey(file);
    const data = serializeDossier(dossier);
    await this.storage.saveCache({
      key: dossierCacheKey(file),
      data,
      timestamp: Date.now(),
      size: data.byteLength,
    });
  }
}
