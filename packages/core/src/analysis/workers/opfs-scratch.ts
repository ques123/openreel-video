/**
 * OPFS scratch space for the perception funnel (worker-side).
 *
 * WHY: reading multi-GB dropped Files through Chrome's blob machinery
 * (blob.slice()/stream()) leaks browser-process memory roughly proportional
 * to bytes served — a 17GB clip drove the browser process to ~14.5GB and
 * crashed all of Chrome. The fix: stream-copy the File into OPFS ONCE (a
 * single sequential pass, the gentlest possible blob usage), then do all
 * random-access decode reads via FileSystemSyncAccessHandle — direct disk
 * I/O with no blob/browser-process involvement.
 *
 * Sync access handles hold an EXCLUSIVE lock per file, which is fine here:
 * the visual and audio passes for a clip are already serialized.
 */

import { StreamSource } from "mediabunny";

// FileSystemSyncAccessHandle is a dedicated-worker-only API missing from the
// project's TS lib; declare the minimal surface we use.
interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface SyncCapableFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

const SCRATCH_DIR = "perception-scratch";

async function getScratchDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SCRATCH_DIR, { create: true });
}

/** Bytes of OPFS quota still available, or null when unknown. */
export async function availableQuota(): Promise<number | null> {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (quota === undefined) return null;
    return Math.max(0, quota - (usage ?? 0));
  } catch {
    return null;
  }
}

/**
 * Stream-copy a Blob into the OPFS scratch dir under `key`.
 * Single sequential read of the source; bounded memory (one chunk at a time).
 */
export async function copyBlobToScratch(
  blob: Blob,
  key: string,
  onProgress?: (bytesDone: number, bytesTotal: number) => void,
  shouldCancel?: () => boolean,
): Promise<void> {
  const dir = await getScratchDir();
  const fileHandle = (await dir.getFileHandle(key, { create: true })) as SyncCapableFileHandle;
  const access = await fileHandle.createSyncAccessHandle();
  try {
    access.truncate(0);
    const reader = blob.stream().getReader();
    let offset = 0;
    let lastReport = 0;
    for (;;) {
      if (shouldCancel?.()) throw new Error("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      access.write(value, { at: offset });
      offset += value.byteLength;
      const now = performance.now();
      if (onProgress && now - lastReport > 200) {
        lastReport = now;
        onProgress(offset, blob.size);
      }
    }
    access.flush();
    onProgress?.(offset, blob.size);
    // A blob stream that ends early (without erroring) would leave a
    // truncated scratch file and very confusing downstream failures.
    if (offset !== blob.size) {
      throw new Error(
        `ingest truncated: source stream ended at ${offset} of ${blob.size} bytes`,
      );
    }
    console.log(
      `[perception] ingest ok: ${(offset / 1e9).toFixed(2)}GB written to OPFS scratch`,
    );
  } finally {
    access.close();
  }
}

/**
 * Stream-copy a byte range of a Blob into a scratch file. Uses ONE
 * slice().stream() — sequential streamed reads are leak-free in Chrome's
 * blob layer (verified with a 17GB single-pass read); it's the storm of
 * random-access slices that leaks browser-process memory.
 */
export async function copyRangeToScratch(
  blob: Blob,
  key: string,
  start: number,
  end: number,
  onProgress?: (bytesDone: number, bytesTotal: number) => void,
  shouldCancel?: () => boolean,
): Promise<void> {
  const dir = await getScratchDir();
  const fileHandle = (await dir.getFileHandle(key, { create: true })) as SyncCapableFileHandle;
  const access = await fileHandle.createSyncAccessHandle();
  const expected = end - start;
  try {
    access.truncate(0);
    const reader = blob.slice(start, end).stream().getReader();
    let offset = 0;
    let lastReport = 0;
    for (;;) {
      if (shouldCancel?.()) throw new Error("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      access.write(value, { at: offset });
      offset += value.byteLength;
      const now = performance.now();
      if (onProgress && now - lastReport > 200) {
        lastReport = now;
        onProgress(offset, expected);
      }
    }
    access.flush();
    onProgress?.(offset, expected);
    if (offset !== expected) {
      throw new Error(`ingest truncated: got ${offset} of ${expected} bytes`);
    }
  } finally {
    access.close();
  }
}

/** Byte layout of a partial (prefix + tail) scratch ingest. */
export interface PartialScratchMeta {
  totalSize: number;
  /** Bytes [0, prefixBytes) live in the main scratch file. */
  prefixBytes: number;
  /** Bytes [tailStart, totalSize) live in the "<key>.tail" scratch file. */
  tailStart: number;
}

export interface ScratchReader {
  source: StreamSource;
  close: () => void;
}

// ---------------------------------------------------------------------------
// Rolling-window ingest: analyze clips of ANY length inside a bounded OPFS
// footprint. The visual scan is a single sequential pass, so the file is
// ingested one byte-window at a time; each window is deleted before the next
// is copied. Three scratch files cooperate per clip:
//   <key>       — the CURRENT window's bytes [windowStart, windowStart+windowBytes)
//   <key>.head  — the first HEAD_BYTES of the file (ftyp/moov-at-front), kept
//                 for the whole run so every window's Input can parse the container
//   <key>.tail  — the last TAIL_BYTES (moov-at-end index), ditto
// ---------------------------------------------------------------------------

/** Bytes of file head kept for all windows (container boxes before mdat). */
export const WINDOW_HEAD_BYTES = 64 * 2 ** 20;
/** Bytes of file tail kept for all windows (moov index usually lives there). */
export const WINDOW_TAIL_BYTES = 64 * 2 ** 20;
/**
 * Consecutive windows overlap by this many bytes so the keyframe preceding a
 * window's first requested timestamp is always readable (seeks land on the
 * sync frame BEFORE the resume point). 128MB ≈ 10s of 100Mbps footage —
 * comfortably more than any consumer GOP.
 */
export const WINDOW_OVERLAP_BYTES = 128 * 2 ** 20;
/** Smallest useful window; below this a clear quota error beats thrashing. */
export const MIN_WINDOW_BYTES = 1 * 2 ** 30;

/** Byte layout of one rolling-window scratch state. */
export interface WindowScratchMeta {
  totalSize: number;
  /** Bytes [0, headBytes) live in "<key>.head". */
  headBytes: number;
  /** Bytes [windowStart, windowStart + windowBytes) live in the main "<key>" file. */
  windowStart: number;
  windowBytes: number;
  /** Bytes [tailStart, totalSize) live in "<key>.tail". */
  tailStart: number;
}

export interface IngestWindowPlan {
  /** Byte ranges to ingest, in order. windows[i+1] overlaps windows[i]'s end. */
  windows: Array<{ startByte: number; endByte: number }>;
  headBytes: number;
  tailBytes: number;
}

/**
 * Plan the rolling windows for a file of totalSize bytes under budgetBytes
 * of usable quota (already safety-margined by the caller). Pure.
 * Whole file fits → single window [0, totalSize) with headBytes/tailBytes 0
 * (plain copyBlobToScratch territory). Otherwise a multi-window plan where
 * every window after the first starts WINDOW_OVERLAP_BYTES before the
 * previous window's end and the last window ends at totalSize. Returns null
 * when the budget can't hold MIN_WINDOW_BYTES + head + tail.
 */
export function planIngestWindows(
  totalSize: number,
  budgetBytes: number,
): IngestWindowPlan | null {
  void totalSize; void budgetBytes;
  throw new Error("not implemented");
}

/**
 * Open a rolling-window layout as a mediabunny StreamSource. Reads are
 * served from whichever of window/head/tail covers the range (window wins
 * on overlap); a read outside all three throws a descriptive error naming
 * the byte range — the funnel treats that as a bug surface, not a signal
 * (windowed scans request only timestamps the window covers). Caller MUST
 * close() (sync handles are exclusive).
 */
export async function openWindowScratchSource(
  key: string,
  meta: WindowScratchMeta,
): Promise<ScratchReader> {
  void key; void meta;
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------
// PCM sidecar: 16k mono f32le audio extracted during the visual pass, so the
// whisper pass never needs the (long-deleted) video windows.
// ---------------------------------------------------------------------------

/** Append raw f32 samples to the "<key>" scratch file (creates on first call). */
export async function appendPcmToScratch(
  key: string,
  samples: Float32Array,
): Promise<void> {
  void key; void samples;
  throw new Error("not implemented");
}

export interface PcmScratchReader {
  /** Total sample count in the file. */
  sampleCount: number;
  /** Read [offsetSamples, offsetSamples + samples) — clamped at EOF. */
  read: (offsetSamples: number, samples: number) => Float32Array;
  close: () => void;
}

/** Open a PCM sidecar for chunked reads. Caller MUST close(). */
export async function openPcmScratch(key: string): Promise<PcmScratchReader> {
  void key;
  throw new Error("not implemented");
}

/**
 * Delete exactly ONE scratch entry by name — no companion fan-out. The
 * window loop uses this to drop a finished window while `.head`/`.tail`/
 * `.audio` must live on.
 */
export async function deleteScratchEntry(name: string): Promise<void> {
  void name;
  throw new Error("not implemented");
}

/**
 * Open a scratch file as a mediabunny StreamSource backed by a sync access
 * handle. Caller MUST call close() (the handle holds an exclusive lock).
 */
export async function openScratchSource(key: string): Promise<ScratchReader> {
  const dir = await getScratchDir();
  const fileHandle = (await dir.getFileHandle(key)) as SyncCapableFileHandle;
  const access = await fileHandle.createSyncAccessHandle();
  const size = access.getSize();
  let closed = false;

  const source = new StreamSource({
    getSize: () => size,
    read: (start, end) => {
      const buffer = new Uint8Array(end - start);
      const bytesRead = access.read(buffer, { at: start });
      return bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
    },
    maxCacheSize: 64 * 2 ** 20,
    prefetchProfile: "fileSystem",
  });

  return {
    source,
    close: () => {
      if (!closed) {
        closed = true;
        access.close();
      }
    },
  };
}

/**
 * Open a PARTIAL scratch ingest (prefix + tail files) as a single Source
 * over the original file's byte space. Reads inside the un-ingested gap
 * throw — callers must cap their access range to the prefix.
 */
export async function openPartialScratchSource(
  key: string,
  meta: PartialScratchMeta,
): Promise<ScratchReader> {
  const dir = await getScratchDir();
  const mainHandle = (await dir.getFileHandle(key)) as SyncCapableFileHandle;
  const tailHandle = (await dir.getFileHandle(`${key}.tail`)) as SyncCapableFileHandle;
  const main = await mainHandle.createSyncAccessHandle();
  const tail = await tailHandle.createSyncAccessHandle();
  let closed = false;

  const source = new StreamSource({
    getSize: () => meta.totalSize,
    read: (start, end) => {
      if (start >= meta.tailStart) {
        const buffer = new Uint8Array(end - start);
        const bytesRead = tail.read(buffer, { at: start - meta.tailStart });
        return bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
      }
      if (start < meta.prefixBytes) {
        // Clamp reads that would spill into the gap; a short read at the
        // prefix edge reads as EOF-ish, which the capped timestamps avoid.
        const clampedEnd = Math.min(end, meta.prefixBytes);
        const buffer = new Uint8Array(clampedEnd - start);
        const bytesRead = main.read(buffer, { at: start });
        return bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
      }
      throw new Error(
        `read at ${start} is beyond the ingested range (partial ingest due to storage quota)`,
      );
    },
    maxCacheSize: 64 * 2 ** 20,
    prefetchProfile: "fileSystem",
  });

  return {
    source,
    close: () => {
      if (!closed) {
        closed = true;
        main.close();
        tail.close();
      }
    },
  };
}

/** Delete one scratch file (and its tail companion, if any). */
export async function deleteScratch(key: string): Promise<void> {
  try {
    const dir = await getScratchDir();
    await dir.removeEntry(key).catch(() => undefined);
    await dir.removeEntry(`${key}.tail`).catch(() => undefined);
    await dir.removeEntry(`${key}.head`).catch(() => undefined);
    await dir.removeEntry(`${key}.audio`).catch(() => undefined);
  } catch {
    // already gone / never created
  }
}

/** Remove ALL scratch files (stale leftovers from crashed sessions). */
export async function clearScratch(): Promise<void> {
  try {
    const dir = await getScratchDir();
    const names: string[] = [];
    // FileSystemDirectoryHandle async iteration
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name);
    }
    await Promise.all(names.map((name) => dir.removeEntry(name).catch(() => undefined)));
  } catch {
    // OPFS unavailable — nothing to clear
  }
}
