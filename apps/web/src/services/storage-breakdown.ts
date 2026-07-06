/**
 * Lab storage ledger: measure how the origin's storage splits across the
 * perception lab's big consumers, with per-category clears — previously the
 * only number was navigator.storage.estimate()'s shrinking total and the
 * only remedy the app-wide clearAllData() sledgehammer.
 *
 * Categories:
 *  - dossiers:          IndexedDB cache records with the "perception:"
 *                       prefix — EVERY dossier version, so stale leftovers
 *                       from DOSSIER_VERSION bumps are counted (and cleared)
 *                       too, which is exactly where invisible bytes hide.
 *  - experiments:       director run records + their index ("director-exp:").
 *  - experimentVideos:  rendered debug videos ("director-exp-video:").
 *  - otherCache:        everything else in the cache store (editor frame
 *                       caches etc.) — measured for context, no clear here.
 *  - OPFS scratch:      the funnel workers' scratch directory (mirrors
 *                       workers/opfs-scratch.ts, which is worker-only and
 *                       deliberately not exported from @openreel/core).
 *
 * Measurement walks the cache store with a cursor: IndexedDB offers no
 * key+size projection, so each record (including multi-hundred-MB video
 * ArrayBuffers) is materialized one at a time to read its `size` field.
 * Disk-I/O heavy — call on demand (a button), never on a render path.
 *
 * Experiment-scoped clears live in experiments.ts (deleteAllExperiments /
 * deleteAllExperimentVideos) — that module owns those keys and their index.
 */

import { DB_NAME, STORES } from "@openreel/core";

/** Mirror of workers/opfs-scratch.ts SCRATCH_DIR (worker-only module). */
const SCRATCH_DIR = "perception-scratch";

const DOSSIER_PREFIX = "perception:";
const EXP_PREFIX = "director-exp:";
const VIDEO_PREFIX = "director-exp-video:";

export type CacheCategory = "dossiers" | "experiments" | "experimentVideos" | "otherCache";

export interface CacheEntryLike {
  key: string;
  size: number;
}

export interface CategoryUsage {
  bytes: number;
  count: number;
}

export interface OpfsScratchUsage extends CategoryUsage {
  /**
   * True when some entries could not be sized (e.g. exclusive sync-access
   * locks held by a running analysis) — bytes/count are then a lower bound.
   */
  partial: boolean;
}

export interface StorageBreakdown {
  cache: Record<CacheCategory, CategoryUsage>;
  /** null = OPFS unavailable in this browser/context. */
  opfsScratch: OpfsScratchUsage | null;
}

/**
 * Bucket one cache-store key. Pure. Note "director-exp-video:" does NOT
 * share the "director-exp:" prefix (hyphen vs colon after "exp"), but the
 * video check runs first anyway so the two can never shadow each other.
 */
export function categorizeCacheKey(key: string): CacheCategory {
  if (key.startsWith(DOSSIER_PREFIX)) return "dossiers";
  if (key.startsWith(VIDEO_PREFIX)) return "experimentVideos";
  if (key.startsWith(EXP_PREFIX)) return "experiments";
  return "otherCache";
}

/** Sum entries into per-category byte/count totals. Pure. */
export function aggregateCacheEntries(
  entries: Iterable<CacheEntryLike>,
): Record<CacheCategory, CategoryUsage> {
  const out: Record<CacheCategory, CategoryUsage> = {
    dossiers: { bytes: 0, count: 0 },
    experiments: { bytes: 0, count: 0 },
    experimentVideos: { bytes: 0, count: 0 },
    otherCache: { bytes: 0, count: 0 },
  };
  for (const entry of entries) {
    const bucket = out[categorizeCacheKey(entry.key)];
    bucket.bytes += entry.size;
    bucket.count += 1;
  }
  return out;
}

/**
 * Open the app's IndexedDB at whatever version exists. On a fresh profile
 * this creates an empty shell (no stores) — callers guard with
 * objectStoreNames.contains; StorageEngine's next open (higher DB_VERSION)
 * upgrades it with the real stores.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

async function readCacheEntries(): Promise<CacheEntryLike[]> {
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains(STORES.CACHE)) return [];
    return await new Promise<CacheEntryLike[]>((resolve, reject) => {
      const entries: CacheEntryLike[] = [];
      const tx = db.transaction(STORES.CACHE, "readonly");
      const req = tx.objectStore(STORES.CACHE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(entries);
          return;
        }
        const value = cursor.value as { size?: number; data?: ArrayBuffer };
        entries.push({
          key: String(cursor.key),
          size: typeof value.size === "number" ? value.size : (value.data?.byteLength ?? 0),
        });
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("cache cursor failed"));
    });
  } finally {
    db.close();
  }
}

/**
 * Size the OPFS scratch directory by iterating its entries; null when OPFS
 * is unavailable, empty usage when the directory was never created.
 */
export async function measureOpfsScratch(): Promise<OpfsScratchUsage | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    return null;
  }
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await root.getDirectoryHandle(SCRATCH_DIR);
  } catch {
    return { bytes: 0, count: 0, partial: false };
  }
  const usage: OpfsScratchUsage = { bytes: 0, count: 0, partial: false };
  try {
    // Async directory iteration is missing from the project's TS lib.
    const iter = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
    for await (const handle of iter) {
      if (handle.kind !== "file") continue;
      usage.count += 1;
      try {
        usage.bytes += (await (handle as FileSystemFileHandle).getFile()).size;
      } catch {
        usage.partial = true; // locked by a running analysis — size unknown
      }
    }
  } catch {
    usage.partial = true;
  }
  return usage;
}

/** One cache walk + one OPFS walk; see module doc for cost caveats. */
export async function measureStorageBreakdown(): Promise<StorageBreakdown> {
  const [entries, opfsScratch] = await Promise.all([readCacheEntries(), measureOpfsScratch()]);
  return { cache: aggregateCacheEntries(entries), opfsScratch };
}

/**
 * Delete every cached dossier — all versions, including stale ones from
 * DOSSIER_VERSION bumps. Clips re-analyze from source on next drop. Returns
 * the number of records deleted.
 */
export async function clearDossierCache(): Promise<number> {
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains(STORES.CACHE)) return 0;
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORES.CACHE, "readwrite");
      const store = tx.objectStore(STORES.CACHE);
      // Every key with the "perception:" prefix (keys are plain strings).
      const range = IDBKeyRange.bound(DOSSIER_PREFIX, DOSSIER_PREFIX + "\uffff");
      let deleted = 0;
      const countReq = store.count(range);
      countReq.onsuccess = () => {
        deleted = countReq.result;
        store.delete(range);
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error ?? new Error("dossier clear failed"));
    });
  } finally {
    db.close();
  }
}

/**
 * Delete every OPFS scratch file. Entries holding exclusive sync-access
 * locks (a clip mid-analysis) fail to delete and are skipped. Returns the
 * number of entries removed.
 */
export async function clearOpfsScratch(): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return 0;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(SCRATCH_DIR);
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name);
    }
    let removed = 0;
    await Promise.all(
      names.map(async (name) => {
        try {
          await dir.removeEntry(name);
          removed += 1;
        } catch {
          // exclusive lock held by a running analysis — leave it
        }
      }),
    );
    return removed;
  } catch {
    return 0; // OPFS unavailable or scratch dir never created
  }
}
