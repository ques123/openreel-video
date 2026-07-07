/**
 * The Presets editor form: every field of PublishedPreset except id/version/
 * publishedAt (server-owned — see services/gateway/src/admin.ts
 * mergePresetFields). Resets from server truth whenever `preset` (id or
 * version) changes — no optimistic local state survives a save.
 */
import { useEffect, useState } from "react";
import type { PublishedPreset } from "@wizz/contracts";
import { DIRECTOR_MODELS } from "../../../services/openai-proxy";
import { defaultLabSettings, loadLabSettings } from "../../../pages/lab/lab-settings";
import { ConfirmButton } from "../../../pages/lab/components/ConfirmButton";
import { adminActivatePreset, adminSavePreset } from "../../../services/gateway";
import { describeProbeError } from "../../AdminProbeResult";
import { salvageLabSettingsJson } from "../../lib/lab-settings-salvage";
import { DurationChipsEditor } from "./DurationChipsEditor";
import { StyleWhitelistEditor } from "./StyleWhitelistEditor";

type EditableFields = Omit<PublishedPreset, "id" | "version" | "publishedAt" | "labSettings">;

/** Positive field selection (not destructure-and-discard) — id/version/publishedAt are server-owned, labSettings is edited separately as JSON text. */
function fieldsFrom(preset: PublishedPreset): EditableFields {
  return {
    name: preset.name,
    styleWhitelist: preset.styleWhitelist,
    directorModel: preset.directorModel,
    promptMode: preset.promptMode,
    transcriptSource: preset.transcriptSource,
    cloudSTTDefaultOn: preset.cloudSTTDefaultOn,
    cloudCaptionsEnabled: preset.cloudCaptionsEnabled,
    musicEnabled: preset.musicEnabled,
    targetDurationChoicesS: preset.targetDurationChoicesS,
    allowCustomDuration: preset.allowCustomDuration,
    minTargetDurationS: preset.minTargetDurationS,
    maxTargetDurationS: preset.maxTargetDurationS,
  };
}

export function PresetEditorForm({
  preset,
  isActive,
  onSaved,
  onActivated,
}: {
  preset: PublishedPreset;
  isActive: boolean;
  onSaved: () => void;
  onActivated: () => void;
}) {
  const [fields, setFields] = useState<EditableFields>(() => fieldsFrom(preset));
  const [labSettingsText, setLabSettingsText] = useState(() =>
    JSON.stringify(preset.labSettings ?? defaultLabSettings(), null, 2),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [salvageDiff, setSalvageDiff] = useState<{ before: unknown; after: unknown } | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<unknown>(null);

  useEffect(() => {
    setFields(fieldsFrom(preset));
    setLabSettingsText(JSON.stringify(preset.labSettings ?? defaultLabSettings(), null, 2));
    setSaveError(null);
    setSalvageDiff(null);
    // Reload whenever the SERVER's copy changes identity (new selection, or a fresh version after save).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.id, preset.version]);

  const set = <K extends keyof EditableFields>(key: K, value: EditableFields[K]) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const durationError =
    fields.minTargetDurationS <= 0 || fields.maxTargetDurationS < fields.minTargetDurationS
      ? "min must be > 0 and max must be ≥ min"
      : null;

  const save = () => {
    const { migrated, changed, before } = salvageLabSettingsJson(labSettingsText);
    setSaving(true);
    setSaveError(null);
    adminSavePreset({ ...preset, ...fields, labSettings: migrated })
      .then(() => {
        setSalvageDiff(changed ? { before, after: migrated } : null);
        onSaved();
      })
      .catch((error: unknown) => setSaveError(error))
      .finally(() => setSaving(false));
  };

  const activate = () => {
    setActivating(true);
    setActivateError(null);
    adminActivatePreset(preset.id)
      .then(() => onActivated())
      .catch((error: unknown) => setActivateError(error))
      .finally(() => setActivating(false));
  };

  const directorModelOptions = Array.from(new Set<string>([...DIRECTOR_MODELS, fields.directorModel]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="flex-1 text-xs text-text-secondary">
          Name
          <input
            type="text"
            value={fields.name}
            onChange={(e) => set("name", e.target.value)}
            className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
          />
        </label>
        <div className="ml-3 shrink-0">
          {isActive ? (
            <span className="rounded bg-status-success/20 px-2 py-1 text-xs font-medium text-status-success">
              Currently active
            </span>
          ) : (
            <ConfirmButton
              onConfirm={activate}
              disabled={activating}
              className="rounded border border-primary px-2 py-1 text-xs text-primary disabled:opacity-40"
              confirmLabel="sure? click again"
            >
              {activating ? "activating…" : "Activate"}
            </ConfirmButton>
          )}
        </div>
      </div>
      {activateError !== null && <p className="text-xs text-status-error">{describeProbeError(activateError)}</p>}

      <div>
        <h3 className="mb-1 text-xs font-semibold text-text-primary">Style whitelist</h3>
        <StyleWhitelistEditor whitelist={fields.styleWhitelist} onChange={(v) => set("styleWhitelist", v)} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-secondary">
          Director model
          <select
            value={fields.directorModel}
            onChange={(e) => set("directorModel", e.target.value)}
            className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
          >
            {directorModelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Prompt mode
          <select
            value={fields.promptMode}
            onChange={(e) => set("promptMode", e.target.value as EditableFields["promptMode"])}
            className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
          >
            <option value="candidates">candidates</option>
            <option value="full">full</option>
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Transcript source
          <select
            value={fields.transcriptSource}
            onChange={(e) => set("transcriptSource", e.target.value as EditableFields["transcriptSource"])}
            className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
          >
            <option value="local">local</option>
            <option value="cloud">cloud</option>
          </select>
          {fields.transcriptSource === "cloud" && (
            <span className="mt-0.5 block text-[10px] text-status-warning">
              cloud whisper hallucinates on non-speech until the VAD-gate-uploads fast-follow lands (WS-E) —
              stay on &ldquo;local&rdquo; for the public preset until then.
            </span>
          )}
        </label>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={fields.cloudSTTDefaultOn}
            onChange={(e) => set("cloudSTTDefaultOn", e.target.checked)}
          />
          Cloud STT default on
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={fields.cloudCaptionsEnabled}
            onChange={(e) => set("cloudCaptionsEnabled", e.target.checked)}
          />
          Cloud captions enabled
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={fields.musicEnabled}
            onChange={(e) => set("musicEnabled", e.target.checked)}
          />
          Music enabled
        </label>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold text-text-primary">Duration chips</h3>
        <DurationChipsEditor
          durations={fields.targetDurationChoicesS}
          onChange={(v) => set("targetDurationChoicesS", v)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={fields.allowCustomDuration}
              onChange={(e) => set("allowCustomDuration", e.target.checked)}
            />
            allow custom duration
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            min (s)
            <input
              type="number"
              min={1}
              value={fields.minTargetDurationS}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (!Number.isNaN(v)) set("minTargetDurationS", v);
              }}
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-text-primary outline-none focus:border-primary"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            max (s)
            <input
              type="number"
              min={1}
              value={fields.maxTargetDurationS}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (!Number.isNaN(v)) set("maxTargetDurationS", v);
              }}
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-text-primary outline-none focus:border-primary"
            />
          </label>
        </div>
        {durationError && <p className="mt-1 text-[11px] text-status-error">{durationError}</p>}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-text-primary">Lab settings (JSON)</h3>
          <button
            type="button"
            onClick={() => setLabSettingsText(JSON.stringify(loadLabSettings(), null, 2))}
            className="rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary"
            title="Reads your own browser's localStorage lab settings (pages/lab/lab-settings.ts)"
          >
            seed from my current lab settings
          </button>
        </div>
        <textarea
          value={labSettingsText}
          onChange={(e) => setLabSettingsText(e.target.value)}
          rows={10}
          spellCheck={false}
          className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-text-primary outline-none focus:border-primary"
        />
        <p className="mt-1 text-[10px] text-text-secondary/70">
          Validated on save through migrateLabSettings — invalid/unknown fields silently fall back per-field
          (a broken preset can never brick the public app); the salvaged result is shown below if it differed
          from what you typed.
        </p>
        {salvageDiff && (
          <div className="mt-1.5 grid grid-cols-1 gap-2 rounded border border-status-warning/40 bg-status-warning/10 p-2 sm:grid-cols-2">
            <div>
              <p className="mb-0.5 text-[10px] font-semibold text-status-warning">as typed</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-text-secondary">
                {JSON.stringify(salvageDiff.before, null, 2) ?? "undefined (unparseable JSON)"}
              </pre>
            </div>
            <div>
              <p className="mb-0.5 text-[10px] font-semibold text-status-warning">salvaged &amp; saved</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-text-secondary">
                {JSON.stringify(salvageDiff.after, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || Boolean(durationError)}
          className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {saving ? "saving…" : "Save"}
        </button>
        {saveError !== null && <p className="text-xs text-status-error">{describeProbeError(saveError)}</p>}
      </div>
    </div>
  );
}
