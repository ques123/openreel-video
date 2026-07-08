/**
 * file-handles.ts: the restore decision loop (restoreFromRows) is tested
 * against plain mock FileSystemFileHandle-like objects — no IndexedDB
 * involved. The session-persistence functions (remember/forget/restore/
 * clear) are tested against a small in-memory fake of the IndexedDB API
 * surface this module actually uses (open/upgrade/transaction/objectStore
 * put/get/getAll/delete/clear) — the shared test/setup.ts indexedDB stub is
 * a non-functional placeholder (its open() never calls onsuccess), so every
 * test here installs its own.
 *
 * The analysis-cache probe behind SessionInfo.rememberedCount is tested with
 * @openreel/core module-mocked (vi.hoisted + vi.mock, same shape as
 * bridges/media-bridge.test.ts): hasCurrentDossier is the ONLY runtime
 * import file-handles.ts takes from core, and the real one reaches into
 * core's own IndexedDB-backed StorageEngine — a second database the fake
 * below doesn't (and shouldn't) model.
 *
 * Note: test/setup.ts installs its placeholder via
 * `Object.defineProperty(window, "indexedDB", {writable: true, value: ...})`
 * with no `configurable` (defaults to false) — `vi.stubGlobal` redefines the
 * property descriptor internally and throws "Cannot redefine property" on a
 * non-configurable one. Since the property IS writable, a plain assignment
 * (`globalThis.indexedDB = ...`) works fine and is restored the same way in
 * afterEach — this sidesteps the conflict without touching the shared setup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  forgetClip,
  getStoredSessionInfo,
  handleFromDataTransferItem,
  pickFilesWithHandles,
  probeRememberedCount,
  rememberClip,
  restoreFromRows,
  restoreSession,
  type StoredClip,
} from "./file-handles";

const { mockHasCurrentDossier } = vi.hoisted(() => ({
  mockHasCurrentDossier: vi.fn(),
}));

vi.mock("@openreel/core", () => ({
  hasCurrentDossier: mockHasCurrentDossier,
}));

/* ─────────────────────── minimal in-memory fake IndexedDB ─────────────────────── */

/**
 * IDBValidKey / PermissionState (lib.dom.d.ts), named indirectly — same
 * `no-undef`/type-only-global gap as file-handles.ts's own PermissionStateLike
 * (see its doc comment); derived from already-recognized DOM types instead
 * of redefining/importing across the file for one line each.
 */
type IDBKeyLike = Parameters<IDBObjectStore["delete"]>[0];
type PermissionStateLike = Awaited<ReturnType<Permissions["query"]>>["state"];

/** Populated by installFakeIndexedDB(); drained in afterEach. */
const installedIndexedDBRestores: (() => void)[] = [];

function installFakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string | undefined>();

  function makeRequest<T>() {
    return { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, result: undefined as T | undefined };
  }

  function objectStore(name: string, onComplete: () => void) {
    const map = stores.get(name)!;
    const keyPath = keyPaths.get(name);
    const complete = () => queueMicrotask(onComplete);
    return {
      put: (value: unknown, key?: IDBKeyLike) => {
        const req = makeRequest<IDBKeyLike>();
        const k = keyPath ? String((value as Record<string, unknown>)[keyPath]) : String(key);
        queueMicrotask(() => {
          map.set(k, value);
          req.onsuccess?.();
          complete();
        });
        return req;
      },
      get: (key: IDBKeyLike) => {
        const req = makeRequest<unknown>();
        queueMicrotask(() => {
          req.result = map.get(String(key));
          req.onsuccess?.();
          complete();
        });
        return req;
      },
      getAll: () => {
        const req = makeRequest<unknown[]>();
        queueMicrotask(() => {
          req.result = [...map.values()];
          req.onsuccess?.();
          complete();
        });
        return req;
      },
      delete: (key: IDBKeyLike) => {
        const req = makeRequest<undefined>();
        queueMicrotask(() => {
          map.delete(String(key));
          req.onsuccess?.();
          complete();
        });
        return req;
      },
      clear: () => {
        const req = makeRequest<undefined>();
        queueMicrotask(() => {
          map.clear();
          req.onsuccess?.();
          complete();
        });
        return req;
      },
    };
  }

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string, options?: { keyPath?: string }) => {
      stores.set(name, new Map());
      keyPaths.set(name, options?.keyPath);
      return {};
    },
    transaction: (_name: string, _mode?: string) => {
      const tx: {
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        objectStore: (storeName: string) => ReturnType<typeof objectStore>;
      } = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: (storeName: string) => objectStore(storeName, () => tx.oncomplete?.()),
      };
      return tx;
    },
  };

  const fakeIndexedDB = {
    open: (_name: string, _version?: number) => {
      const req: {
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        result: typeof db;
      } = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  // Plain assignment, not vi.stubGlobal — see the file-header note on why.
  const original = globalThis.indexedDB;
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB;
  installedIndexedDBRestores.push(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = original;
  });
  return { stores };
}

/* ─────────────────────────── fake FileSystemFileHandle ─────────────────────────── */

/**
 * Returns the richer object (with the mock fns still visible for
 * `expect(...).toHaveBeenCalledWith(...)` assertions) rather than casting to
 * FileSystemFileHandle immediately — passing it where a FileSystemFileHandle
 * is expected still type-checks (excess properties are fine through a named
 * variable, just not through an inline object literal).
 */
function makeFakeHandle(opts: {
  name?: string;
  queryResult?: PermissionStateLike;
  requestResult?: PermissionStateLike;
  getFileError?: Error;
}) {
  return {
    kind: "file" as const,
    name: opts.name ?? "clip.mp4",
    queryPermission: vi.fn(async (): Promise<PermissionStateLike> => opts.queryResult ?? "granted"),
    requestPermission: vi.fn(
      async (): Promise<PermissionStateLike> => opts.requestResult ?? opts.queryResult ?? "granted",
    ),
    getFile: vi.fn(async () => {
      if (opts.getFileError) throw opts.getFileError;
      return new File(["x"], opts.name ?? "clip.mp4", { type: "video/mp4" });
    }),
    // Unused by these tests, but required to fully satisfy FileSystemFileHandle.
    createWritable: vi.fn(async () => {
      throw new Error("createWritable not implemented in this test fake");
    }),
    isSameEntry: vi.fn(async () => false),
  };
}

function row(
  id: string,
  handle: FileSystemFileHandle,
  name = "clip.mp4",
  lastModifiedAtSave?: number,
): StoredClip {
  return { id, name, sizeAtSave: 100, lastModifiedAtSave, handle };
}

beforeEach(() => {
  mockHasCurrentDossier.mockReset();
  mockHasCurrentDossier.mockResolvedValue(false);
});

afterEach(() => {
  while (installedIndexedDBRestores.length > 0) installedIndexedDBRestores.pop()!();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ───────────────────────────────── tests ───────────────────────────────── */

describe("restoreFromRows (pure decision loop, no IndexedDB)", () => {
  it("restores every clip when permission is already granted", async () => {
    const rows = [row("a", makeFakeHandle({})), row("b", makeFakeHandle({}))];
    const result = await restoreFromRows(rows);
    expect(result.restored.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.moved).toEqual([]);
  });

  it("requests permission when not already granted, and restores on approval", async () => {
    const handle = makeFakeHandle({ queryResult: "prompt", requestResult: "granted" });
    const result = await restoreFromRows([row("a", handle)]);
    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: "read" });
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "read" });
    expect(result.restored).toHaveLength(1);
  });

  it("degrades to 'moved' when permission is denied", async () => {
    const handle = makeFakeHandle({ queryResult: "prompt", requestResult: "denied" });
    const result = await restoreFromRows([row("a", handle, "gone.mp4")]);
    expect(result.restored).toEqual([]);
    expect(result.moved).toEqual([{ id: "a", name: "gone.mp4" }]);
  });

  it("degrades to 'moved' when the underlying file is gone (getFile throws)", async () => {
    const handle = makeFakeHandle({ getFileError: new DOMException("not found", "NotFoundError") });
    const result = await restoreFromRows([row("a", handle, "moved.mp4")]);
    expect(result.moved).toEqual([{ id: "a", name: "moved.mp4" }]);
  });

  it("handles a mixed batch independently — one bad clip doesn't sink the others", async () => {
    const good = makeFakeHandle({});
    const bad = makeFakeHandle({ getFileError: new Error("gone") });
    const result = await restoreFromRows([row("good", good, "a.mp4"), row("bad", bad, "b.mp4")]);
    expect(result.restored.map((r) => r.id)).toEqual(["good"]);
    expect(result.moved).toEqual([{ id: "bad", name: "b.mp4" }]);
  });
});

describe("probeRememberedCount (pure probe math, mocked analysis cache)", () => {
  it("counts every row when the whole cache survived, probing each under its SAVED identity", async () => {
    mockHasCurrentDossier.mockResolvedValue(true);
    const rows = [row("a", makeFakeHandle({}), "a.mp4", 111), row("b", makeFakeHandle({}), "b.mp4", 222)];
    await expect(probeRememberedCount(rows)).resolves.toBe(2);
    expect(mockHasCurrentDossier).toHaveBeenCalledWith({ name: "a.mp4", size: 100, lastModified: 111 });
    expect(mockHasCurrentDossier).toHaveBeenCalledWith({ name: "b.mp4", size: 100, lastModified: 222 });
  });

  it("counts zero when nothing is cached any more (evicted or pipeline-version bumped)", async () => {
    const rows = [row("a", makeFakeHandle({}), "a.mp4", 111), row("b", makeFakeHandle({}), "b.mp4", 222)];
    await expect(probeRememberedCount(rows)).resolves.toBe(0);
  });

  it("counts only the hits on a partially surviving cache", async () => {
    mockHasCurrentDossier.mockImplementation(async (identity: { name: string }) => identity.name !== "b.mp4");
    const rows = [
      row("a", makeFakeHandle({}), "a.mp4", 111),
      row("b", makeFakeHandle({}), "b.mp4", 222),
      row("c", makeFakeHandle({}), "c.mp4", 333),
    ];
    await expect(probeRememberedCount(rows)).resolves.toBe(2);
  });

  it("returns null — no claim at all — when ANY row lacks lastModifiedAtSave (legacy session)", async () => {
    mockHasCurrentDossier.mockResolvedValue(true);
    const rows = [row("a", makeFakeHandle({}), "a.mp4", 111), row("b", makeFakeHandle({}), "b.mp4")];
    await expect(probeRememberedCount(rows)).resolves.toBeNull();
    expect(mockHasCurrentDossier).not.toHaveBeenCalled();
  });

  it("treats a rejected or throwing probe as not-remembered instead of failing the whole count", async () => {
    mockHasCurrentDossier
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("storage exploded"))
      .mockImplementationOnce(() => {
        throw new Error("sync throw");
      });
    const rows = [
      row("a", makeFakeHandle({}), "a.mp4", 111),
      row("b", makeFakeHandle({}), "b.mp4", 222),
      row("c", makeFakeHandle({}), "c.mp4", 333),
    ];
    await expect(probeRememberedCount(rows)).resolves.toBe(1);
  });
});

describe("session persistence (fake IndexedDB)", () => {
  let fakeStores: Map<string, Map<string, unknown>>;

  beforeEach(() => {
    fakeStores = installFakeIndexedDB().stores;
  });

  it("has no stored session before anything is remembered", async () => {
    await expect(getStoredSessionInfo()).resolves.toBeNull();
  });

  it("remembering a clip creates a session with clipCount 1", async () => {
    await rememberClip({ id: "a", name: "a.mp4", size: 10, lastModified: 111, handle: makeFakeHandle({}) });
    const info = await getStoredSessionInfo();
    expect(info?.clipCount).toBe(1);
  });

  it("rememberClip captures the live File's identity — sizeAtSave AND lastModifiedAtSave", async () => {
    const file = new File(["xx"], "a.mp4", { type: "video/mp4", lastModified: 1_720_000_000_000 });
    await rememberClip({
      id: file.name,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      handle: makeFakeHandle({ name: file.name }),
    });
    const stored = fakeStores.get("clips")?.get("a.mp4") as StoredClip;
    expect(stored.sizeAtSave).toBe(file.size);
    expect(stored.lastModifiedAtSave).toBe(1_720_000_000_000);
  });

  it("getStoredSessionInfo probes each stored row against the analysis cache and counts the hits", async () => {
    mockHasCurrentDossier.mockImplementation(async (identity: { name: string }) => identity.name === "a.mp4");
    await rememberClip({ id: "a", name: "a.mp4", size: 10, lastModified: 111, handle: makeFakeHandle({}) });
    await rememberClip({ id: "b", name: "b.mp4", size: 20, lastModified: 222, handle: makeFakeHandle({}) });
    const info = await getStoredSessionInfo();
    expect(info?.rememberedCount).toBe(1);
    expect(mockHasCurrentDossier).toHaveBeenCalledWith({ name: "a.mp4", size: 10, lastModified: 111 });
    expect(mockHasCurrentDossier).toHaveBeenCalledWith({ name: "b.mp4", size: 20, lastModified: 222 });
  });

  it("getStoredSessionInfo reports a null rememberedCount when any stored row predates lastModifiedAtSave", async () => {
    mockHasCurrentDossier.mockResolvedValue(true);
    await rememberClip({ id: "a", name: "a.mp4", size: 10, lastModified: 111, handle: makeFakeHandle({}) });
    await rememberClip({ id: "b", name: "b.mp4", size: 10, lastModified: 222, handle: makeFakeHandle({}) });
    // Rows written before the field existed simply lack it — recreate one in place.
    delete (fakeStores.get("clips")!.get("b") as { lastModifiedAtSave?: number }).lastModifiedAtSave;
    const info = await getStoredSessionInfo();
    expect(info?.clipCount).toBe(2);
    expect(info?.rememberedCount).toBeNull();
    expect(mockHasCurrentDossier).not.toHaveBeenCalled();
  });

  it("remembering more clips bumps clipCount but keeps the original savedAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    await rememberClip({ id: "a", name: "a.mp4", size: 10, lastModified: 111, handle: makeFakeHandle({}) });
    const first = await getStoredSessionInfo();

    vi.setSystemTime(new Date("2026-07-02T00:00:00.000Z"));
    await rememberClip({ id: "b", name: "b.mp4", size: 10, lastModified: 222, handle: makeFakeHandle({}) });
    const second = await getStoredSessionInfo();

    expect(second?.clipCount).toBe(2);
    expect(second?.savedAt).toBe(first?.savedAt);
  });

  it("forgetting a clip decrements clipCount without touching savedAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    await rememberClip({ id: "a", name: "a.mp4", size: 10, lastModified: 111, handle: makeFakeHandle({}) });
    await rememberClip({ id: "b", name: "b.mp4", size: 10, lastModified: 222, handle: makeFakeHandle({}) });
    const before = await getStoredSessionInfo();

    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    await forgetClip("a");
    const after = await getStoredSessionInfo();

    expect(after?.clipCount).toBe(1);
    expect(after?.savedAt).toBe(before?.savedAt);
  });

  it("forgetting the last clip clears the session entirely", async () => {
    await rememberClip({ id: "a", name: "a.mp4", size: 10, lastModified: 111, handle: makeFakeHandle({}) });
    await forgetClip("a");
    await expect(getStoredSessionInfo()).resolves.toBeNull();
  });

  it("clearSession drops everything regardless of clip count", async () => {
    await rememberClip({ id: "a", name: "a.mp4", size: 10, lastModified: 111, handle: makeFakeHandle({}) });
    await rememberClip({ id: "b", name: "b.mp4", size: 10, lastModified: 222, handle: makeFakeHandle({}) });
    await clearSession();
    await expect(getStoredSessionInfo()).resolves.toBeNull();
  });

  it("restoreSession resolves every remembered handle when all are healthy", async () => {
    await rememberClip({
      id: "a",
      name: "a.mp4",
      size: 10,
      lastModified: 111,
      handle: makeFakeHandle({ name: "a.mp4" }),
    });
    await rememberClip({
      id: "b",
      name: "b.mp4",
      size: 10,
      lastModified: 222,
      handle: makeFakeHandle({ name: "b.mp4" }),
    });
    const result = await restoreSession();
    expect(result.restored.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(result.moved).toEqual([]);
    await expect(getStoredSessionInfo()).resolves.toEqual(
      expect.objectContaining({ clipCount: 2 }),
    );
  });

  it("restoreSession prunes moved clips from storage but keeps the healthy ones", async () => {
    await rememberClip({
      id: "ok",
      name: "ok.mp4",
      size: 10,
      lastModified: 111,
      handle: makeFakeHandle({ name: "ok.mp4" }),
    });
    await rememberClip({
      id: "gone",
      name: "gone.mp4",
      size: 10,
      lastModified: 222,
      handle: makeFakeHandle({ getFileError: new DOMException("nope", "NotFoundError") }),
    });

    const result = await restoreSession();
    expect(result.restored.map((r) => r.id)).toEqual(["ok"]);
    expect(result.moved).toEqual([{ id: "gone", name: "gone.mp4" }]);

    const info = await getStoredSessionInfo();
    expect(info?.clipCount).toBe(1);

    // The moved clip is really gone — a second restore only sees "ok".
    const second = await restoreSession();
    expect(second.restored.map((r) => r.id)).toEqual(["ok"]);
    expect(second.moved).toEqual([]);
  });

  it("restoreSession clears the session when every clip has moved", async () => {
    await rememberClip({
      id: "gone",
      name: "gone.mp4",
      size: 10,
      lastModified: 111,
      handle: makeFakeHandle({ getFileError: new Error("nope") }),
    });
    await restoreSession();
    await expect(getStoredSessionInfo()).resolves.toBeNull();
  });
});

describe("handleFromDataTransferItem", () => {
  function makeItem(getAsFileSystemHandle?: () => Promise<unknown>) {
    return { getAsFileSystemHandle } as unknown as DataTransferItem;
  }

  it("returns the handle when it's a file-kind handle", async () => {
    const handle = makeFakeHandle({});
    const item = makeItem(async () => handle);
    await expect(handleFromDataTransferItem(item)).resolves.toBe(handle);
  });

  it("returns null for a directory-kind handle", async () => {
    const item = makeItem(async () => ({ kind: "directory" }));
    await expect(handleFromDataTransferItem(item)).resolves.toBeNull();
  });

  it("returns null when the browser doesn't support getAsFileSystemHandle", async () => {
    const item = makeItem(undefined);
    await expect(handleFromDataTransferItem(item)).resolves.toBeNull();
  });

  it("returns null (not a throw) when the browser rejects the call", async () => {
    const item = makeItem(async () => {
      throw new Error("nope");
    });
    await expect(handleFromDataTransferItem(item)).resolves.toBeNull();
  });
});

describe("pickFilesWithHandles", () => {
  // A plain property assignment on the real `window` (adding/removing
  // `showOpenFilePicker`, which doesn't exist by default) rather than
  // vi.stubGlobal("window", ...) replacing the whole global — swapping out
  // `window` itself risks the same "Cannot redefine property" failure mode
  // as indexedDB above if jsdom's own binding isn't configurable, and there's
  // no need to go that wide for one method.
  type WindowWithPicker = Window & { showOpenFilePicker?: (...args: unknown[]) => unknown };

  afterEach(() => {
    delete (window as WindowWithPicker).showOpenFilePicker;
  });

  it("maps picked handles to {file, handle} pairs", async () => {
    const handle = makeFakeHandle({ name: "picked.mp4" });
    (window as WindowWithPicker).showOpenFilePicker = vi.fn(async () => [handle]);
    const result = await pickFilesWithHandles();
    expect(result).toHaveLength(1);
    expect(result[0].handle).toBe(handle);
    expect(result[0].file.name).toBe("picked.mp4");
  });

  it("returns an empty array when the user cancels (AbortError)", async () => {
    (window as WindowWithPicker).showOpenFilePicker = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(pickFilesWithHandles()).resolves.toEqual([]);
  });

  it("returns an empty array when the browser has no picker at all", async () => {
    delete (window as WindowWithPicker).showOpenFilePicker;
    await expect(pickFilesWithHandles()).resolves.toEqual([]);
  });
});
