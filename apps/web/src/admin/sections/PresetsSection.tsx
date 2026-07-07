/**
 * Presets: list + editor for the public product's entire settings surface
 * (style whitelist, director model, duration chips, lab settings…). See
 * docs/wizz-video-plan.md §WS-C and docs/wizz-contracts.md §2.
 */
import { useEffect, useRef, useState } from "react";
import type { GlobalSettings, PublishedPreset } from "@wizz/contracts";
import { adminGetSettings, adminListPresets } from "../../services/gateway";
import { adminCreatePreset } from "../lib/gateway-admin-extra";
import { AdminProbeResult, describeProbeError, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";
import { PresetEditorForm } from "./presets/PresetEditorForm";
import { PresetsList } from "./presets/PresetsList";

interface Loaded {
  presets: PublishedPreset[];
  settings: GlobalSettings;
}

export function PresetsSection() {
  const [state, setState] = useState<ProbeState<Loaded>>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const hasAutoSelected = useRef(false);

  const load = (selectAfter?: string) => {
    setState((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    Promise.all([adminListPresets(), adminGetSettings()])
      .then(([{ presets }, settings]) => {
        setState({ status: "ok", data: { presets, settings } });
        if (selectAfter) {
          setSelectedId(selectAfter);
        } else if (!hasAutoSelected.current && presets.length > 0) {
          hasAutoSelected.current = true;
          setSelectedId(settings.activePresetId ?? presets[0].id);
        }
      })
      .catch((error: unknown) => setState({ status: "error", error }));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createNew = () => {
    setCreating(true);
    setCreateError(null);
    adminCreatePreset({})
      .then(({ preset }) => load(preset.id))
      .catch((error: unknown) => setCreateError(error))
      .finally(() => setCreating(false));
  };

  return (
    <SectionPage
      title="Presets"
      wide
      description="Edit and publish the public product's settings surface — the style whitelist, director model, duration options, and locked lab settings."
    >
      <AdminProbeResult
        state={state}
        render={({ presets, settings }) => {
          const activePreset = presets.find((p) => p.id === settings.activePresetId) ?? null;
          const selected = presets.find((p) => p.id === selectedId) ?? null;
          return (
            <div>
              <p className="mb-3 rounded border border-border bg-background-secondary px-3 py-2 text-xs text-text-secondary">
                The public app currently gets:{" "}
                {activePreset ? (
                  <span className="font-medium text-text-primary">
                    {activePreset.name} (v{activePreset.version})
                  </span>
                ) : (
                  <span className="font-medium text-text-primary">
                    no active preset → the built-in default (wizz launch preset)
                  </span>
                )}
              </p>

              <div className="flex gap-4">
                <div className="w-64 shrink-0">
                  <button
                    type="button"
                    onClick={createNew}
                    disabled={creating}
                    className="mb-2 w-full rounded border border-border px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                  >
                    {creating ? "creating…" : "+ create new preset"}
                  </button>
                  {createError !== null && (
                    <p className="mb-2 text-[11px] text-status-error">{describeProbeError(createError)}</p>
                  )}
                  <PresetsList
                    presets={presets}
                    activePresetId={settings.activePresetId}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                </div>
                <div className="min-w-0 flex-1 rounded-md border border-border bg-background-secondary p-3">
                  {selected ? (
                    <PresetEditorForm
                      key={selected.id}
                      preset={selected}
                      isActive={selected.id === settings.activePresetId}
                      onSaved={() => load(selected.id)}
                      onActivated={() => load(selected.id)}
                    />
                  ) : (
                    <p className="text-sm text-text-secondary">Select a preset to edit, or create a new one.</p>
                  )}
                </div>
              </div>
            </div>
          );
        }}
      />
    </SectionPage>
  );
}
