/**
 * Pure aggregation logic of the storage ledger: key bucketing (including the
 * "director-exp-video:" vs "director-exp:" prefix trap) and per-category
 * byte/count totals.
 */

import { describe, expect, it } from "vitest";
import { aggregateCacheEntries, categorizeCacheKey } from "./storage-breakdown";

describe("categorizeCacheKey", () => {
  it("buckets dossier keys of EVERY pipeline version", () => {
    expect(categorizeCacheKey("perception:v3:clip.mp4:123:456")).toBe("dossiers");
    expect(categorizeCacheKey("perception:v11:clip.mp4:123:456")).toBe("dossiers");
  });

  it("keeps experiment records and their index together", () => {
    expect(categorizeCacheKey("director-exp:exp-abc123")).toBe("experiments");
    expect(categorizeCacheKey("director-exp:index")).toBe("experiments");
  });

  it("never confuses videos with records (hyphen-vs-colon prefix trap)", () => {
    expect(categorizeCacheKey("director-exp-video:exp-abc123")).toBe("experimentVideos");
  });

  it("sends everything else (editor frame caches etc.) to otherCache", () => {
    expect(categorizeCacheKey("proj-1:clip-2:0.04")).toBe("otherCache");
    expect(categorizeCacheKey("")).toBe("otherCache");
    expect(categorizeCacheKey("perceptionX:not-a-dossier")).toBe("otherCache");
  });
});

describe("aggregateCacheEntries", () => {
  it("returns all-zero buckets for an empty store", () => {
    const agg = aggregateCacheEntries([]);
    for (const bucket of Object.values(agg)) {
      expect(bucket).toEqual({ bytes: 0, count: 0 });
    }
  });

  it("sums bytes and counts per category", () => {
    const agg = aggregateCacheEntries([
      { key: "perception:v3:a.mp4:1:2", size: 100 },
      { key: "perception:v2:b.mp4:3:4", size: 50 },
      { key: "director-exp:exp-1", size: 7 },
      { key: "director-exp:index", size: 3 },
      { key: "director-exp-video:exp-1", size: 5_000_000 },
      { key: "frame:proj:clip:0", size: 9 },
    ]);
    expect(agg.dossiers).toEqual({ bytes: 150, count: 2 });
    expect(agg.experiments).toEqual({ bytes: 10, count: 2 });
    expect(agg.experimentVideos).toEqual({ bytes: 5_000_000, count: 1 });
    expect(agg.otherCache).toEqual({ bytes: 9, count: 1 });
  });
});
