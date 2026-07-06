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
 * Geometry overrides for planIngestWindows. Production callers omit this
 * (the exported constants apply); the debug-budget test hook scales the
 * geometry down so small fixtures exercise the real multi-window path.
 */
export interface IngestWindowOpts {
  headBytes?: number;
  tailBytes?: number;
  overlapBytes?: number;
  minWindowBytes?: number;
}

/**
 * Plan the rolling windows for a file of totalSize bytes under budgetBytes
 * of usable quota (already safety-margined by the caller). Pure.
 * Whole file fits → single window [0, totalSize) with headBytes/tailBytes 0
 * (plain copyBlobToScratch territory). Otherwise a multi-window plan where
 * every window after the first starts overlapBytes before the previous
 * window's end and the last window ends at totalSize. Returns null when the
 * budget can't hold minWindowBytes + head + tail.
 */
export function planIngestWindows(
  totalSize: number,
  budgetBytes: number,
  opts: IngestWindowOpts = {},
): IngestWindowPlan | null {
  const headLimit = opts.headBytes ?? WINDOW_HEAD_BYTES;
  const tailLimit = opts.tailBytes ?? WINDOW_TAIL_BYTES;
  const overlapBytes = opts.overlapBytes ?? WINDOW_OVERLAP_BYTES;
  const minWindowBytes = opts.minWindowBytes ?? MIN_WINDOW_BYTES;

  if (totalSize <= budgetBytes) {
    return { windows: [{ startByte: 0, endByte: totalSize }], headBytes: 0, tailBytes: 0 };
  }

  const headBytes = Math.min(headLimit, totalSize);
  const tailBytes = Math.min(tailLimit, totalSize);
  const capacity = budgetBytes - headBytes - tailBytes;

  // Below this a window is either uselessly small or too small relative to
  // the overlap for the next window's start (prevEnd - OVERLAP) to clear
  // the previous window's start — the loop below could stall or regress.
  const minCapacity = Math.max(minWindowBytes, 2 * overlapBytes);
  if (capacity < minCapacity) {
    return null;
  }

  const windows: Array<{ startByte: number; endByte: number }> = [];
  let endByte = Math.min(capacity, totalSize);
  windows.push({ startByte: 0, endByte });

  while (endByte < totalSize) {
    const prevEnd = endByte;
    const startByte = Math.max(0, prevEnd - overlapBytes);
    endByte = Math.min(startByte + capacity, totalSize);
    if (endByte <= prevEnd) {
      // Should be unreachable given the capacity guard above; a hard throw
      // beats an infinite loop if the invariant is ever violated.
      throw new Error(
        `planIngestWindows: no forward progress (prevEnd=${prevEnd}, nextEnd=${endByte})`,
      );
    }
    windows.push({ startByte, endByte });
  }

  return { windows, headBytes, tailBytes };
}

/** One resolved piece of a scatter-gather read across window/head/tail files. */
export interface WindowReadSegment {
  file: "window" | "head" | "tail";
  /** Offset to read from within `file`. */
  srcOffset: number;
  /** Offset within the caller's destination buffer to place the bytes at. */
  dstOffset: number;
  len: number;
}

/** Clip [start, end) to [rangeStart, rangeEnd); null when the overlap is empty. */
function clampToRange(
  start: number,
  end: number,
  rangeStart: number,
  rangeEnd: number,
): [number, number] | null {
  const s = Math.max(start, rangeStart);
  const e = Math.min(end, rangeEnd);
  return e > s ? [s, e] : null;
}

/** Pieces of [start, end) NOT covered by [cutStart, cutEnd) (0, 1, or 2 pieces). */
function subtractRange(
  start: number,
  end: number,
  cutStart: number,
  cutEnd: number,
): Array<[number, number]> {
  if (cutEnd <= start || cutStart >= end) return [[start, end]];
  const pieces: Array<[number, number]> = [];
  if (cutStart > start) pieces.push([start, cutStart]);
  if (cutEnd < end) pieces.push([cutEnd, end]);
  return pieces;
}

/**
 * Resolve a byte range against the three cooperating scratch files, in
 * precedence order window > head > tail — the window's copy of a byte is
 * always the freshest, and can genuinely overlap head (first window starts
 * at 0) or tail (last window ends at totalSize). Pure; exported for unit
 * tests. Returns null when some subrange of [start, end) is covered by NONE
 * of the three files (a read outside the current rolling window).
 */
export function mapWindowRead(
  meta: WindowScratchMeta,
  start: number,
  end: number,
): WindowReadSegment[] | null {
  if (end <= start) return [];

  const layers: Array<{
    file: WindowReadSegment["file"];
    rangeStart: number;
    rangeEnd: number;
    toSrcOffset: (byte: number) => number;
  }> = [
    {
      file: "window",
      rangeStart: meta.windowStart,
      rangeEnd: meta.windowStart + meta.windowBytes,
      toSrcOffset: (byte) => byte - meta.windowStart,
    },
    {
      file: "head",
      rangeStart: 0,
      rangeEnd: meta.headBytes,
      toSrcOffset: (byte) => byte,
    },
    {
      file: "tail",
      rangeStart: meta.tailStart,
      rangeEnd: meta.totalSize,
      toSrcOffset: (byte) => byte - meta.tailStart,
    },
  ];

  const segments: WindowReadSegment[] = [];
  let remaining: Array<[number, number]> = [[start, end]];

  for (const layer of layers) {
    if (layer.rangeEnd <= layer.rangeStart) continue; // e.g. headBytes === 0
    const nextRemaining: Array<[number, number]> = [];
    for (const [rStart, rEnd] of remaining) {
      const covered = clampToRange(rStart, rEnd, layer.rangeStart, layer.rangeEnd);
      if (!covered) {
        nextRemaining.push([rStart, rEnd]);
        continue;
      }
      const [cStart, cEnd] = covered;
      segments.push({
        file: layer.file,
        srcOffset: layer.toSrcOffset(cStart),
        dstOffset: cStart - start,
        len: cEnd - cStart,
      });
      nextRemaining.push(...subtractRange(rStart, rEnd, cStart, cEnd));
    }
    remaining = nextRemaining;
  }

  if (remaining.length > 0) return null;

  segments.sort((a, b) => a.dstOffset - b.dstOffset);
  return segments;
}

/**
 * Open a rolling-window layout as a mediabunny StreamSource. Reads are
 * served from whichever of window/head/tail covers the range (window wins
 * on overlap); a read outside all three throws a descriptive error naming
 * the byte range — the funnel treats that as a bug surface, not a signal
 * (windowed scans request only timestamps the window covers). Caller MUST
 * close() (sync handles are exclusive).
 */
/**
 * Total bytes of out-of-coverage reads a window source may serve straight
 * from the source Blob before erroring. Container parsers occasionally read
 * OUTSIDE head/window/tail — e.g. a moov/trailer that starts earlier than
 * the tail cut. A few small random-access blob reads are harmless (the
 * Chrome blob leak is a per-byte cost that only matters at GB scale, which
 * this cap makes impossible); unbounded fallback would silently reintroduce
 * exactly that leak, hence the hard ceiling.
 */
export const WINDOW_BLOB_FALLBACK_MAX_BYTES = 64 * 2 ** 20;

export async function openWindowScratchSource(
  key: string,
  meta: WindowScratchMeta,
  /**
   * Source Blob for BOUNDED out-of-coverage fallback reads (see
   * WINDOW_BLOB_FALLBACK_MAX_BYTES). Omit to make uncovered reads throw.
   */
  fallbackBlob?: Blob,
): Promise<ScratchReader> {
  const dir = await getScratchDir();

  const windowHandle = (await dir.getFileHandle(key)) as SyncCapableFileHandle;
  const windowAccess = await windowHandle.createSyncAccessHandle();

  // Open head/tail handles ONLY when the meta actually references them — a
  // small fully-ingested file (headBytes 0, tailStart === totalSize) never
  // had ".head"/".tail" scratch files created for it.
  let head: SyncAccessHandle | null = null;
  if (meta.headBytes > 0) {
    const headHandle = (await dir.getFileHandle(`${key}.head`)) as SyncCapableFileHandle;
    head = await headHandle.createSyncAccessHandle();
  }

  let tail: SyncAccessHandle | null = null;
  if (meta.tailStart < meta.totalSize) {
    const tailHandle = (await dir.getFileHandle(`${key}.tail`)) as SyncCapableFileHandle;
    tail = await tailHandle.createSyncAccessHandle();
  }

  let closed = false;
  let fallbackBytesUsed = 0;
  let fallbackWarned = false;

  const source = new StreamSource({
    getSize: () => meta.totalSize,
    read: (start, end) => {
      const segments = mapWindowRead(meta, start, end);
      if (!segments) {
        // Out-of-coverage read (container box outside head/window/tail).
        // Serve it from the source Blob — bounded, so a pathological layout
        // can't reintroduce the blob-layer memory leak.
        const len = end - start;
        if (fallbackBlob && fallbackBytesUsed + len <= WINDOW_BLOB_FALLBACK_MAX_BYTES) {
          fallbackBytesUsed += len;
          if (!fallbackWarned) {
            fallbackWarned = true;
            console.warn(
              `[perception] window source: read at ${start}..${end} is outside ` +
                `head/window/tail coverage — serving from the source blob ` +
                `(container metadata outside the ingest windows; capped at ` +
                `${WINDOW_BLOB_FALLBACK_MAX_BYTES / 2 ** 20}MB per clip).`,
            );
          }
          return fallbackBlob
            .slice(start, end)
            .arrayBuffer()
            .then((buf) => new Uint8Array(buf));
        }
        throw new Error(
          `read at ${start}..${end} is outside the current ingest window (rolling-window analysis)` +
            (fallbackBlob ? ` and the ${WINDOW_BLOB_FALLBACK_MAX_BYTES / 2 ** 20}MB blob-fallback budget is exhausted` : ""),
        );
      }
      const buffer = new Uint8Array(end - start);
      for (const segment of segments) {
        const handle =
          segment.file === "window" ? windowAccess : segment.file === "head" ? head : tail;
        if (!handle) {
          // mapWindowRead only emits a segment for a layer whose range is
          // non-empty, which is exactly when we open that handle above —
          // reaching here means the two have drifted out of sync.
          throw new Error(
            `opfs-scratch: no open handle for "${segment.file}" segment (internal error)`,
          );
        }
        const view = buffer.subarray(segment.dstOffset, segment.dstOffset + segment.len);
        const bytesRead = handle.read(view, { at: segment.srcOffset });
        if (bytesRead !== view.byteLength) {
          throw new Error(
            `short read from "${segment.file}" at ${segment.srcOffset}: got ${bytesRead} of ${view.byteLength} bytes`,
          );
        }
      }
      return buffer;
    },
    maxCacheSize: 64 * 2 ** 20,
    prefetchProfile: "fileSystem",
  });

  return {
    source,
    close: () => {
      if (!closed) {
        closed = true;
        windowAccess.close();
        head?.close();
        tail?.close();
      }
    },
  };
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
  const dir = await getScratchDir();
  const fileHandle = (await dir.getFileHandle(key, { create: true })) as SyncCapableFileHandle;
  const access = await fileHandle.createSyncAccessHandle();
  try {
    const offset = access.getSize();
    access.write(samples, { at: offset });
    access.flush();
  } finally {
    access.close();
  }
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
  const dir = await getScratchDir();
  const fileHandle = (await dir.getFileHandle(key)) as SyncCapableFileHandle;
  const access = await fileHandle.createSyncAccessHandle();
  const sampleCount = Math.floor(access.getSize() / 4);
  let closed = false;

  return {
    sampleCount,
    read: (offsetSamples, samples) => {
      const count = Math.max(0, Math.min(samples, sampleCount - offsetSamples));
      if (count === 0) return new Float32Array(0);
      const bytes = new Uint8Array(count * 4);
      const bytesRead = access.read(bytes, { at: offsetSamples * 4 });
      // Fresh ArrayBuffer allocated on this call — never aliases a
      // reused/shared buffer that a later read() would overwrite.
      return new Float32Array(bytes.buffer, 0, Math.floor(bytesRead / 4));
    },
    close: () => {
      if (!closed) {
        closed = true;
        access.close();
      }
    },
  };
}

/**
 * Delete exactly ONE scratch entry by name — no companion fan-out. The
 * window loop uses this to drop a finished window while `.head`/`.tail`/
 * `.audio` must live on.
 */
export async function deleteScratchEntry(name: string): Promise<void> {
  try {
    const dir = await getScratchDir();
    await dir.removeEntry(name).catch(() => undefined);
  } catch {
    // already gone / never created
  }
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
