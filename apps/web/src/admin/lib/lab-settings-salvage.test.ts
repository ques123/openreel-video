import { describe, expect, it } from "vitest";
import { defaultLabSettings } from "../../pages/lab/lab-settings";
import { salvageLabSettingsJson } from "./lab-settings-salvage";

describe("salvageLabSettingsJson", () => {
  it("reports unchanged for a full, already-valid LabSettings object", () => {
    const valid = defaultLabSettings();
    const result = salvageLabSettingsJson(JSON.stringify(valid));
    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual(valid);
  });

  it("salvages empty text to full defaults and reports it changed", () => {
    const result = salvageLabSettingsJson("");
    expect(result.before).toBeUndefined();
    expect(result.migrated).toEqual(defaultLabSettings());
    expect(result.changed).toBe(true);
  });

  it("salvages unparseable JSON to full defaults rather than throwing", () => {
    const result = salvageLabSettingsJson("{ not: valid json");
    expect(result.migrated).toEqual(defaultLabSettings());
    expect(result.changed).toBe(true);
  });

  it("salvages a partially-valid object per-field, keeping the valid fields", () => {
    const raw = JSON.stringify({ transcription: { localModel: "large-v3-turbo", vad: "not-a-boolean" } });
    const result = salvageLabSettingsJson(raw);
    expect(result.migrated.transcription).toEqual({ localModel: "large-v3-turbo", vad: true });
    expect(result.changed).toBe(true);
  });
});
