import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SELECTOR_CONFIG } from "@openreel/core";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PUBLISHED_PRESET,
  type PresetResponse,
  type PublishedPreset,
} from "@wizz/contracts";
import { defaultLabSettings } from "../pages/lab/lab-settings-core";
import { GatewayError, getPreset } from "../services/gateway";
import {
  clampDurationBounds,
  labSettingsOf,
  loadPublicRunConfig,
  resolveStyleWhitelist,
} from "./preset-runtime";

vi.mock("../services/gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/gateway")>();
  return { ...actual, getPreset: vi.fn() };
});

beforeEach(() => {
  vi.mocked(getPreset).mockReset();
});

function preset(overrides: Partial<PublishedPreset> = {}): PublishedPreset {
  return { ...DEFAULT_PUBLISHED_PRESET, ...overrides };
}

// ---------------------------------------------------------------------------
// resolveStyleWhitelist
// ---------------------------------------------------------------------------

describe("resolveStyleWhitelist", () => {
  it("resolves known ids to {id, label, tagline} in WHITELIST order", () => {
    const styles = resolveStyleWhitelist(["hype-reel", "atmospheric"]);
    expect(styles).toEqual([
      { id: "hype-reel", label: "Hype reel", tagline: "Only the peaks, maximum punch" },
      { id: "atmospheric", label: "Atmospheric", tagline: "Mood first — the feeling is the story" },
    ]);
  });

  it("silently drops unknown ids (a stale whitelist entry) without breaking the rest", () => {
    const styles = resolveStyleWhitelist(["atmospheric", "not-a-real-id", "cinematic"]);
    expect(styles.map((s) => s.id)).toEqual(["atmospheric", "cinematic"]);
  });

  it("returns [] for an empty whitelist", () => {
    expect(resolveStyleWhitelist([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clampDurationBounds
// ---------------------------------------------------------------------------

describe("clampDurationBounds", () => {
  it("passes through a well-formed preset's bounds and chips unchanged", () => {
    const result = clampDurationBounds(preset());
    expect(result).toEqual({
      minTargetS: DEFAULT_PUBLISHED_PRESET.minTargetDurationS,
      maxTargetS: DEFAULT_PUBLISHED_PRESET.maxTargetDurationS,
      durationChips: DEFAULT_PUBLISHED_PRESET.targetDurationChoicesS,
    });
  });

  it("falls back to the default minimum when minTargetDurationS is zero/negative/non-finite", () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const result = clampDurationBounds(preset({ minTargetDurationS: bad }));
      expect(result.minTargetS).toBe(DEFAULT_PUBLISHED_PRESET.minTargetDurationS);
    }
  });

  it("never lets maxTargetS fall below minTargetS", () => {
    const result = clampDurationBounds(preset({ minTargetDurationS: 120, maxTargetDurationS: 60 }));
    expect(result.minTargetS).toBe(120);
    expect(result.maxTargetS).toBeGreaterThanOrEqual(120);
  });

  it("drops duration chips outside the resolved bounds", () => {
    const result = clampDurationBounds(
      preset({ minTargetDurationS: 30, maxTargetDurationS: 120, targetDurationChoicesS: [10, 60, 999] }),
    );
    expect(result.durationChips).toEqual([60]);
  });

  it("dedupes duration chips while preserving order", () => {
    const result = clampDurationBounds(
      preset({ minTargetDurationS: 15, maxTargetDurationS: 600, targetDurationChoicesS: [30, 60, 30, 90] }),
    );
    expect(result.durationChips).toEqual([30, 60, 90]);
  });

  it("falls back to the default chip set (clamped into bounds) when every chip is invalid or out of range", () => {
    const result = clampDurationBounds(
      preset({ minTargetDurationS: 200, maxTargetDurationS: 250, targetDurationChoicesS: [1, -5, NaN] }),
    );
    // Every default chip (30/60/90/180) is below 200, so all clamp UP to the new minimum.
    expect(result.durationChips.every((c) => c >= 200 && c <= 250)).toBe(true);
    expect(result.durationChips.length).toBeGreaterThan(0);
  });

  it("treats a missing/non-array targetDurationChoicesS as no valid chips (falls back)", () => {
    const result = clampDurationBounds(
      preset({ targetDurationChoicesS: undefined as unknown as number[] }),
    );
    expect(result.durationChips.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadPublicRunConfig — the fallback matrix
// ---------------------------------------------------------------------------

describe("loadPublicRunConfig", () => {
  it("builds a PublicRunConfig from a successful preset fetch, migrating labSettings and resolving styles/cap", () => {
    const fetchedPreset = preset({
      styleWhitelist: ["cinematic", "unknown-id"],
      labSettings: { selector: { topPerChapter: 9 } },
    });
    const response: PresetResponse = {
      preset: fetchedPreset,
      footageCap: { maxClips: 10, maxTotalSeconds: 1200 },
    };
    vi.mocked(getPreset).mockResolvedValue(response);

    return loadPublicRunConfig().then((config) => {
      expect(config.preset).toBe(fetchedPreset);
      expect(config.cap).toEqual({ maxClips: 10, maxTotalSeconds: 1200 });
      expect(config.styles).toEqual([
        { id: "cinematic", label: "Cinematic", tagline: "Sweeping and composed, like a travel film" },
      ]);
      // migrateLabSettings salvaged the one valid field and defaulted the rest.
      expect(labSettingsOf(config).selector.topPerChapter).toBe(9);
      expect(labSettingsOf(config).selector.weights).toEqual(DEFAULT_SELECTOR_CONFIG.weights);
      expect(labSettingsOf(config).transcription).toEqual(defaultLabSettings().transcription);
    });
  });

  it("treats a null labSettings (DEFAULT_PUBLISHED_PRESET's own value) as the default LabSettings equivalent", () => {
    const response: PresetResponse = {
      preset: preset({ labSettings: null }),
      footageCap: DEFAULT_GLOBAL_SETTINGS.footageCap,
    };
    vi.mocked(getPreset).mockResolvedValue(response);

    return loadPublicRunConfig().then((config) => {
      expect(labSettingsOf(config)).toEqual(defaultLabSettings());
    });
  });

  it("falls back to DEFAULT_PUBLISHED_PRESET + default footage cap on a non-auth GatewayError", async () => {
    vi.mocked(getPreset).mockRejectedValue(
      new GatewayError({ code: "upstream_error", status: 502, message: "bad gateway" }),
    );
    const config = await loadPublicRunConfig();
    expect(config.preset).toEqual(DEFAULT_PUBLISHED_PRESET);
    expect(config.cap).toEqual(DEFAULT_GLOBAL_SETTINGS.footageCap);
    expect(labSettingsOf(config)).toEqual(defaultLabSettings());
  });

  it("falls back on kill_switch, rate_limited, and other non-auth codes alike", async () => {
    for (const code of ["kill_switch", "rate_limited", "quota_exceeded", "not_found"] as const) {
      vi.mocked(getPreset).mockRejectedValue(new GatewayError({ code, status: 500, message: code }));
      const config = await loadPublicRunConfig();
      expect(config.preset).toEqual(DEFAULT_PUBLISHED_PRESET);
    }
  });

  it("falls back on a generic (non-GatewayError) rejection too — e.g. an unexpected throw", async () => {
    vi.mocked(getPreset).mockRejectedValue(new TypeError("network fell over"));
    const config = await loadPublicRunConfig();
    expect(config.preset).toEqual(DEFAULT_PUBLISHED_PRESET);
  });

  it("rethrows auth_required rather than falling back (the shell must route to needs-auth)", async () => {
    const authError = new GatewayError({ code: "auth_required", status: 401, message: "no session" });
    vi.mocked(getPreset).mockRejectedValue(authError);
    await expect(loadPublicRunConfig()).rejects.toBe(authError);
  });
});
