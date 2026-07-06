/**
 * Persisted lab settings: cheap-by-default caption model, one versioned
 * localStorage key, and per-field-salvaging migration (one stale value never
 * discards the rest of the object).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  LAB_SETTINGS_KEY,
  LAB_SETTINGS_VERSION,
  defaultLabSettings,
  loadLabSettings,
  migrateLabSettings,
  saveLabSettings,
  type LabSettings,
} from "./lab-settings";

beforeEach(() => {
  localStorage.clear();
});

describe("defaultLabSettings", () => {
  it("defaults the caption model to gpt-5.4-mini (not the flagship)", () => {
    expect(defaultLabSettings()).toEqual({
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "shots", model: "gpt-5.4-mini", candidatesOnly: null },
    });
  });

  it("returns a fresh object each call (no shared mutable default)", () => {
    const a = defaultLabSettings();
    const b = defaultLabSettings();
    expect(a).not.toBe(b);
    expect(a.cloud).not.toBe(b.cloud);
  });
});

describe("migrateLabSettings", () => {
  it("round-trips a fully valid persisted object", () => {
    const settings = {
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "timeline", model: "gpt-5.2", candidatesOnly: false },
    };
    expect(migrateLabSettings(settings)).toEqual(settings);
  });

  it("returns defaults for non-object garbage", () => {
    for (const raw of [null, undefined, 42, "settings", true, []]) {
      expect(migrateLabSettings(raw)).toEqual(defaultLabSettings());
    }
  });

  it("salvages per field: one invalid value keeps the rest", () => {
    expect(
      migrateLabSettings({
        version: LAB_SETTINGS_VERSION,
        cloud: { scope: "timeline", model: "gpt-9-imaginary", candidatesOnly: true },
      }),
    ).toEqual({
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "timeline", model: "gpt-5.4-mini", candidatesOnly: true },
    });
  });

  it("falls back on an invalid scope and a non-boolean candidatesOnly", () => {
    const migrated = migrateLabSettings({
      cloud: { scope: "everything", model: "gpt-5.4-nano", candidatesOnly: "yes" },
    });
    expect(migrated.cloud).toEqual({
      scope: "shots",
      model: "gpt-5.4-nano",
      candidatesOnly: null,
    });
  });

  it("drops unknown fields (persisted shape stays exactly the type)", () => {
    const migrated = migrateLabSettings({
      version: LAB_SETTINGS_VERSION,
      legacyFlag: true,
      cloud: { scope: "shots", model: "gpt-5.2", candidatesOnly: null, extra: 1 },
    });
    expect(Object.keys(migrated).sort()).toEqual(["cloud", "version"]);
    expect(Object.keys(migrated.cloud).sort()).toEqual(["candidatesOnly", "model", "scope"]);
  });
});

describe("load/save", () => {
  it("loads defaults when nothing is stored", () => {
    expect(loadLabSettings()).toEqual(defaultLabSettings());
  });

  it("round-trips through localStorage under the single key", () => {
    const settings: LabSettings = {
      version: LAB_SETTINGS_VERSION,
      cloud: { scope: "timeline", model: "gpt-5.4-nano", candidatesOnly: true },
    };
    saveLabSettings(settings);
    expect(localStorage.getItem(LAB_SETTINGS_KEY)).not.toBeNull();
    expect(loadLabSettings()).toEqual(settings);
  });

  it("survives corrupted stored JSON by returning defaults", () => {
    localStorage.setItem(LAB_SETTINGS_KEY, "{not json");
    expect(loadLabSettings()).toEqual(defaultLabSettings());
  });
});
