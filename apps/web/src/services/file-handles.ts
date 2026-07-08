/**
 * Persistent file handles for the public generate flow's "welcome back"
 * restore (docs/wizz-video-plan.md §WS-D UX decisions / §10 scene 6): one
 * FileSystemFileHandle per dropped clip, captured via
 * DataTransferItem.getAsFileSystemHandle() on drop or
 * showOpenFilePicker({multiple:true}) for the "Choose files…" button — NEVER
 * <input type=file>, which hands back a File with no handle to persist.
 *
 * Deliberately a NEW, narrow module with its own IndexedDB database — NOT
 * @openreel/core's StorageEngine, which already persists file/directory
 * handles for the editor's media library, keyed by name+size with no notion
 * of a "session". The public flow needs exactly that: one remembered
 * footage set with a label, a clip count, and a saved-at time (the "Reload
 * Tuesday's footage · 12 clips" line). The API below is kept narrow and
 * self-contained on purpose so the admin lab could adopt this module later
 * instead of (or beside) StorageEngine's handle methods, killing its
 * re-add-files friction (plan §WS-D).
 *
 * "Single result at a time" extends to footage too: there is exactly one
 * remembered session; each remembered clip replaces any prior entry with the
 * same id, and starting fresh (or a full restore) can replace the set
 * wholesale via clearSession().
 */
import { hasCurrentDossier, type FileIdentity } from "@openreel/core";

const DB_NAME = "wizz-file-handles";
const DB_VERSION = 1;
const CLIPS_STORE = "clips";
const META_STORE = "meta";
const META_KEY = "session";

/**
 * File System Access API pieces missing from this project's bundled
 * TypeScript DOM lib (has FileSystemFileHandle/FileSystemDirectoryHandle but
 * not showOpenFilePicker, the handle permission methods, or
 * DataTransferItem.getAsFileSystemHandle). Declared MODULE-SCOPED here
 * (this file has imports/exports, so these never merge into the global
 * scope) rather than as a global ambient .d.ts: services/project-manager.ts
 * and components/editor/AssetsPanel.tsx already carry their own local
 * versions of the same shapes, and a global augmentation collided with
 * theirs (TS2430 — an optional method can't override the required one a
 * global augmentation would introduce). Matching their existing pattern
 * (local interface + inline cast at the call site) avoids that entirely.
 */
/**
 * PermissionState (lib.dom.d.ts), named indirectly: this project's eslint
 * config's `no-undef` doesn't recognize that specific type-only DOM global
 * (it's absent from eslint.config.js's manually curated globals list — same
 * class of issue as services/gateway.ts's FetchInit comment, and the
 * unfixed pre-existing CanvasImageSource errors in transition-bridge.ts /
 * canvas-renderers.ts). Deriving it from another already-recognized DOM
 * type sidesteps the false positive instead of naming it directly.
 */
type PermissionStateLike = Awaited<ReturnType<Permissions["query"]>>["state"];

interface FileSystemHandleWithPermissions extends FileSystemFileHandle {
  queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionStateLike>;
  requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionStateLike>;
}

interface DataTransferItemWithHandle extends DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

interface PickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface ShowOpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: PickerAcceptType[];
}

interface WindowWithFilePicker {
  showOpenFilePicker?(options?: ShowOpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

/**
 * One persisted clip, keyed by filename (`id === name`, enforced by every
 * caller in publicapp/use-generate-flow.ts).
 *
 * `publicflow`'s PublicPipeline/PublicCut types (WS-E, frozen for WS-D) don't
 * expose a clipId → File accessor the way the lab's use-perception-lab does
 * for StoryboardPreviewModal/debug-export — those read an engine-internal
 * File registry WS-D has no access to yet, and `PublicClip` exposes only
 * `name` (no byte size), so a `name:size` composite key — the convention
 * @openreel/core's StorageEngine uses for its own file-handle store
 * (packages/core/src/storage/storage-engine.ts) — can't be reconstructed at
 * lookup time from a `PublicClip` alone. Filename is therefore the only
 * stable natural key available across the publicflow boundary; two distinct
 * clips sharing an exact filename is an accepted, documented limitation
 * (same spirit as upstream's collision-prone key, just one field narrower).
 */
export interface StoredClip {
  id: string;
  name: string;
  sizeAtSave: number;
  /**
   * Absent on rows saved before this field existed — those legacy sessions
   * can't be probed for a remembered-analysis count (see
   * getStoredSessionInfo/probeRememberedCount below), only the honest
   * "unknowable" null.
   */
  lastModifiedAtSave?: number;
  handle: FileSystemFileHandle;
}

interface SessionMeta {
  savedAt: number;
  clipCount: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CLIPS_STORE)) {
        db.createObjectStore(CLIPS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open wizz-file-handles db"));
  });
}

function putClipRow(row: StoredClip): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CLIPS_STORE, "readwrite");
        tx.objectStore(CLIPS_STORE).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("clip put failed"));
        tx.onabort = () => reject(tx.error ?? new Error("clip put aborted"));
      }),
  );
}

function getAllClipRows(): Promise<StoredClip[]> {
  return openDb().then(
    (db) =>
      new Promise<StoredClip[]>((resolve, reject) => {
        const tx = db.transaction(CLIPS_STORE, "readonly");
        const req = tx.objectStore(CLIPS_STORE).getAll();
        req.onsuccess = () => resolve((req.result as StoredClip[] | undefined) ?? []);
        req.onerror = () => reject(req.error ?? new Error("clip getAll failed"));
      }),
  );
}

function deleteClipRow(id: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CLIPS_STORE, "readwrite");
        tx.objectStore(CLIPS_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("clip delete failed"));
      }),
  );
}

function clearClipRows(): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CLIPS_STORE, "readwrite");
        tx.objectStore(CLIPS_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("clip clear failed"));
      }),
  );
}

function putMeta(meta: SessionMeta): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(META_STORE, "readwrite");
        tx.objectStore(META_STORE).put(meta, META_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("meta put failed"));
      }),
  );
}

function getMeta(): Promise<SessionMeta | null> {
  return openDb().then(
    (db) =>
      new Promise<SessionMeta | null>((resolve, reject) => {
        const tx = db.transaction(META_STORE, "readonly");
        const req = tx.objectStore(META_STORE).get(META_KEY);
        req.onsuccess = () => resolve((req.result as SessionMeta | undefined) ?? null);
        req.onerror = () => reject(req.error ?? new Error("meta get failed"));
      }),
  );
}

function deleteMeta(): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(META_STORE, "readwrite");
        tx.objectStore(META_STORE).delete(META_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("meta delete failed"));
      }),
  );
}

/** After a clip-set mutation, meta.clipCount tracks reality; savedAt is preserved unless `bumpSavedAt`. */
async function syncMetaAfterMutation(bumpSavedAt: boolean): Promise<void> {
  const rows = await getAllClipRows();
  if (rows.length === 0) {
    await deleteMeta();
    return;
  }
  const prior = await getMeta();
  await putMeta({ savedAt: bumpSavedAt || !prior ? Date.now() : prior.savedAt, clipCount: rows.length });
}

/* ────────────────────────────── capture ────────────────────────────── */

/**
 * Best-effort handle capture from a drag-and-drop DataTransferItem. Chrome
 * and Edge (the only supported browsers — WebGPU already gates everything
 * else) support `getAsFileSystemHandle()`; returns null on any failure or
 * absence so the caller always has a File to analyze from regardless of
 * whether a handle could be captured for later restore.
 */
export async function handleFromDataTransferItem(
  item: DataTransferItem,
): Promise<FileSystemFileHandle | null> {
  const withHandle = item as DataTransferItemWithHandle;
  if (typeof withHandle.getAsFileSystemHandle !== "function") return null;
  try {
    const handle = await withHandle.getAsFileSystemHandle();
    return handle && handle.kind === "file" ? (handle as FileSystemFileHandle) : null;
  } catch (err) {
    console.error("[file-handles] getAsFileSystemHandle failed", err);
    return null;
  }
}

export interface PickedFile {
  file: File;
  handle: FileSystemFileHandle;
}

const VIDEO_PICKER_OPTIONS: ShowOpenFilePickerOptions = {
  multiple: true,
  excludeAcceptAllOption: false,
  types: [
    {
      description: "Video",
      accept: { "video/*": [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".lrf"] },
    },
  ],
};

/**
 * The "Choose files…" button path — ALWAYS returns real handles (never
 * `<input type=file>`, which cannot produce one). Empty array on user
 * cancellation or an unsupported browser; errors are logged, not thrown, so
 * a picker hiccup never crashes the bench.
 */
export async function pickFilesWithHandles(): Promise<PickedFile[]> {
  const win = window as Window & WindowWithFilePicker;
  if (typeof win.showOpenFilePicker !== "function") {
    console.error("[file-handles] showOpenFilePicker unsupported in this browser");
    return [];
  }
  try {
    const handles = await win.showOpenFilePicker(VIDEO_PICKER_OPTIONS);
    const out: PickedFile[] = [];
    for (const handle of handles) {
      out.push({ file: await handle.getFile(), handle });
    }
    return out;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return []; // user cancelled — not an error
    console.error("[file-handles] showOpenFilePicker failed", err);
    return [];
  }
}

/* ────────────────────────────── session ────────────────────────────── */

export interface SessionInfo {
  savedAt: number;
  clipCount: number;
  /**
   * How many remembered clips still have a CURRENT-pipeline-version analysis
   * cached; null when the session can't be probed at all — see
   * probeRememberedCount.
   */
  rememberedCount: number | null;
}

/**
 * For the studio-return offer card ("Reload Tuesday's footage? · 12 clips ·
 * analyzed and remembered"); null = nothing remembered. rememberedCount is a
 * fresh probe of @openreel/core's per-clip dossier cache on every call, not
 * a value tracked alongside the session meta — that cache can go stale
 * (never finished, evicted, or invalidated by a pipeline-version bump)
 * independently of anything this module does, so the offer can't just trust
 * "we saved it, therefore it's still analyzed".
 */
export async function getStoredSessionInfo(): Promise<SessionInfo | null> {
  const meta = await getMeta();
  if (!meta) return null;
  const rows = await getAllClipRows();
  return { ...meta, rememberedCount: await probeRememberedCount(rows) };
}

/**
 * How many of these rows still have a current-pipeline-version analysis
 * cached, or null when the session can't be probed at all (any row missing
 * lastModifiedAtSave — a legacy session saved before that field existed, so
 * its cache identity can't be reconstructed for at least one clip). Factored
 * out from IndexedDB access, same spirit as restoreFromRows above, so it's
 * unit-testable against plain rows. Probes run concurrently and are
 * individually failure-safe (see probeRow) — one bad row degrades to
 * "not remembered", never to a thrown error that would break boot.
 */
export async function probeRememberedCount(rows: readonly StoredClip[]): Promise<number | null> {
  if (rows.some((r) => r.lastModifiedAtSave === undefined)) return null;
  const hits = await Promise.all(rows.map(probeRow));
  return hits.filter(Boolean).length;
}

async function probeRow(row: StoredClip): Promise<boolean> {
  if (row.lastModifiedAtSave === undefined) return false;
  const identity: FileIdentity = { name: row.name, size: row.sizeAtSave, lastModified: row.lastModifiedAtSave };
  try {
    return await hasCurrentDossier(identity);
  } catch {
    return false;
  }
}

/** Remembers (or replaces) one clip's handle. Called as each handle-bearing clip joins the bench. */
export async function rememberClip(entry: {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  handle: FileSystemFileHandle;
}): Promise<void> {
  await putClipRow({
    id: entry.id,
    name: entry.name,
    sizeAtSave: entry.size,
    lastModifiedAtSave: entry.lastModified,
    handle: entry.handle,
  });
  await syncMetaAfterMutation(false);
}

/** Drops one clip's remembered handle (e.g. the user removed it from the bench). */
export async function forgetClip(id: string): Promise<void> {
  await deleteClipRow(id);
  await syncMetaAfterMutation(false);
}

/** Drops the whole remembered session (e.g. "Start something new instead"). */
export async function clearSession(): Promise<void> {
  await clearClipRows();
  await deleteMeta();
}

export interface RestoredClip {
  id: string;
  name: string;
  file: File;
}

export interface MovedClip {
  id: string;
  name: string;
}

export interface RestoreResult {
  restored: RestoredClip[];
  moved: MovedClip[];
}

/**
 * The restore decision loop, factored out from IndexedDB access so it's
 * unit-testable against plain mock handle objects. Per stored clip:
 * queryPermission → (if needed) requestPermission → getFile(); any
 * rejection along the way (revoked permission, or the underlying file
 * moved/renamed/deleted — surfaces as getFile() throwing NotFoundError)
 * degrades that ONE clip to "moved" rather than failing the whole restore.
 */
export async function restoreFromRows(rows: readonly StoredClip[]): Promise<RestoreResult> {
  const restored: RestoredClip[] = [];
  const moved: MovedClip[] = [];
  for (const row of rows) {
    try {
      const handle = row.handle as FileSystemHandleWithPermissions;
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm !== "granted") {
        perm = await handle.requestPermission({ mode: "read" });
      }
      if (perm !== "granted") {
        moved.push({ id: row.id, name: row.name });
        continue;
      }
      const file = await row.handle.getFile();
      restored.push({ id: row.id, name: file.name, file });
    } catch (err) {
      console.error(`[file-handles] restore failed for ${row.name}`, err);
      moved.push({ id: row.id, name: row.name });
    }
  }
  return { restored, moved };
}

/**
 * Full restore: loads the persisted session, resolves every clip, and prunes
 * moved clips from storage (the per-file degrade — "drop them again and
 * everything else carries on" — the ones that DID restore stay remembered
 * for next time; the moved ones are gone until re-dropped, at which point
 * the bench re-captures fresh handles for them).
 */
export async function restoreSession(): Promise<RestoreResult> {
  const rows = await getAllClipRows();
  const result = await restoreFromRows(rows);
  if (result.moved.length > 0) {
    for (const m of result.moved) await deleteClipRow(m.id);
    await syncMetaAfterMutation(false);
  }
  return result;
}
