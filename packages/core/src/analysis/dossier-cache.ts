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
  return {
    ...parsed,
    denseCaptions: parsed.denseCaptions ?? [],
    shots: parsed.shots.map((shot) => {
      const { embeddingB64, frameEmbeddingsB64, ...rest } = shot;
      return {
        ...rest,
        embedding: embeddingB64 ? b64ToFloat32(embeddingB64) : null,
        frameEmbeddings: (frameEmbeddingsB64 ?? []).map(b64ToFloat32),
        // Pre-caption caches lack the field; the orchestrator enriches lazily.
        caption: rest.caption ?? null,
      };
    }),
  };
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
      return { ...dossier, recordedAt: dossier.recordedAt ?? file.lastModified };
    } catch {
      return null;
    }
  }

  async save(file: File, dossier: ClipDossier): Promise<void> {
    const data = serializeDossier(dossier);
    await this.storage.saveCache({
      key: dossierCacheKey(file),
      data,
      timestamp: Date.now(),
      size: data.byteLength,
    });
  }
}
