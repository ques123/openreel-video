import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { StorageEngine } from "./storage-engine";

describe("StorageEngine.hasCache", () => {
  it("is true for a saved key and false for one never saved", async () => {
    const storage = new StorageEngine();
    const key = "hasCache-test:present";
    await storage.saveCache({
      key,
      data: new ArrayBuffer(8),
      timestamp: Date.now(),
      size: 8,
    });
    expect(await storage.hasCache(key)).toBe(true);
    expect(await storage.hasCache("hasCache-test:absent")).toBe(false);
  });

  it("answers without deserializing a huge, unparseable value", async () => {
    const storage = new StorageEngine();
    const key = "hasCache-test:garbage";
    // ~3.4MB, and not valid JSON — any code path that tried to JSON.parse
    // this (the way DossierCache.load deserializes a real cached value)
    // would throw. hasCache must never take that path.
    const garbage = new TextEncoder().encode("not valid json{[,".repeat(200_000)).buffer;
    expect(() => JSON.parse(new TextDecoder().decode(garbage))).toThrow();

    await storage.saveCache({ key, data: garbage, timestamp: Date.now(), size: garbage.byteLength });
    await expect(storage.hasCache(key)).resolves.toBe(true);
  });
});
