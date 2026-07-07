import { useEffect } from "react";
import type { CloudScope } from "@openreel/core";
import { CAPTION_MODELS, type CaptionModel } from "../../../services/cloud-vision";
import { shortModelLabel } from "../../../services/openai-proxy";
import { formatAuxSpend, type AuxSpend } from "../enhance-cost";
import {
  LAB_SETTINGS_KEY,
  type CloudEnhanceSettings,
  type LabSettings,
  type TranscriptionSettings,
} from "../lab-settings";

interface SettingsDrawerProps {
  settings: LabSettings;
  /** Patch the persisted cloud-enhance settings (page persists + re-renders). */
  onCloudChange: (patch: Partial<CloudEnhanceSettings>) => void;
  /** Patch the persisted local-whisper settings (page persists + re-renders). */
  onTranscriptionChange: (patch: Partial<TranscriptionSettings>) => void;
  /** Whether the selector currently has candidate shots (drives the auto hint). */
  hasCandidates: boolean;
  /** Effective candidates-only value after the auto rule (what a run would use). */
  candidatesOnlyEffective: boolean;
  /** Session aux LLM spend (brief suggestions, music brief) for the footer. */
  auxSpend: AuxSpend;
  onClose: () => void;
}

/**
 * Right-side drawer over the lab: every persisted enhance dial in one place,
 * backed by the single versioned settings object in lab-settings.ts (the
 * future funnel-preset seam). The per-session cloud-vision consent checkbox
 * stays in the header on purpose — consent is not a setting.
 */
export function SettingsDrawer({
  settings,
  onCloudChange,
  onTranscriptionChange,
  hasCandidates,
  candidatesOnlyEffective,
  auxSpend,
  onClose,
}: SettingsDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div
        className="bg-background-secondary border-l border-border w-80 max-w-full h-full overflow-y-auto p-4 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Enhance settings</h3>
            <p className="text-xs text-text-secondary">
              Persisted on this device — applies to every enhance run.
            </p>
          </div>
          <button
            className="text-text-secondary hover:text-text-primary text-xl px-2 shrink-0"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <label className="block text-xs text-text-secondary">
          <span className="font-medium">scope</span>
          <select
            className="mt-1 w-full bg-background border border-border rounded px-1.5 py-1 text-xs text-text-primary outline-none focus:border-primary"
            value={settings.cloud.scope}
            onChange={(e) => onCloudChange({ scope: e.target.value as CloudScope })}
            title="How much to send per enhance: one frame per shot, or the full sampled timeline"
          >
            <option value="shots">shots only</option>
            <option value="timeline">full timeline</option>
          </select>
        </label>

        <label className="block text-xs text-text-secondary">
          <span className="font-medium">caption model</span>
          <select
            className="mt-1 w-full bg-background border border-border rounded px-1.5 py-1 text-xs text-text-primary outline-none focus:border-primary"
            value={settings.cloud.model}
            onChange={(e) => onCloudChange({ model: e.target.value as CaptionModel })}
            title="Caption model: 5.2 = flagship; 5.4-mini ~3x cheaper; 5.4-nano ~11x cheaper; qwen3-vl via OpenRouter = open-weights ladder (235b ≈ frontier at ~1/5 of mini's output price). Runs per model coexist for comparison."
          >
            {CAPTION_MODELS.map((m) => (
              <option key={m} value={m}>
                {shortModelLabel(m)}
              </option>
            ))}
          </select>
          <span className="block mt-1 text-[10px] text-text-secondary/80">
            default 5.4-mini — measured 91-clip run: $0.55 vs $1.56 on 5.2
          </span>
        </label>

        <div className="text-xs">
          <label
            className="flex items-center gap-1.5 cursor-pointer select-none text-amber-500"
            title="Restrict cloud enhance to the signal-stack selector's candidate shots — cheaper, focused on what the director will actually see highlighted"
          >
            <input
              type="checkbox"
              checked={candidatesOnlyEffective}
              onChange={(e) => onCloudChange({ candidatesOnly: e.target.checked })}
            />
            ★ candidates only
          </label>
          {settings.cloud.candidatesOnly === null ? (
            <p className="mt-1 text-[10px] text-text-secondary/80">
              auto — turns on as soon as the selector has candidate shots
              {hasCandidates ? "" : " (none yet)"}
            </p>
          ) : (
            <button
              className="mt-1 text-[10px] text-text-secondary hover:text-text-primary underline decoration-dotted"
              onClick={() => onCloudChange({ candidatesOnly: null })}
            >
              reset to auto (on when candidates exist)
            </button>
          )}
        </div>

        <div className="pt-3 border-t border-border space-y-2">
          <h4 className="text-xs font-semibold text-text-primary">Transcription</h4>
          <label className="block text-xs text-text-secondary">
            <span className="font-medium">local model</span>
            <select
              className="mt-1 w-full bg-background border border-border rounded px-1.5 py-1 text-xs text-text-primary outline-none focus:border-primary"
              value={settings.transcription.localModel}
              onChange={(e) =>
                onTranscriptionChange({
                  localModel: e.target.value as TranscriptionSettings["localModel"],
                })
              }
              title="Local whisper checkpoint: base is small and fast; large-v3-turbo is much more accurate but downloads ~800MB"
            >
              <option value="base">whisper-base · fast (74M)</option>
              <option value="large-v3-turbo">large-v3-turbo · accurate (~800MB download)</option>
            </select>
            <span className="block mt-1 text-[10px] text-text-secondary/80">
              applies to newly analyzed clips
            </span>
          </label>

          <label
            className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-text-secondary"
            title="Voice-activity gate: only transcribe audio the local VAD thinks is speech"
          >
            <input
              type="checkbox"
              checked={settings.transcription.vad}
              onChange={(e) => onTranscriptionChange({ vad: e.target.checked })}
            />
            skip non-speech audio (fewer hallucinations)
          </label>
        </div>

        <div className="flex-1" />

        <div className="pt-3 border-t border-border space-y-1 text-[10px] text-text-secondary">
          <p>
            aux LLM spend this session:{" "}
            {auxSpend.calls > 0 ? formatAuxSpend(auxSpend) : "none yet"}
            <span className="text-text-secondary/70"> — brief suggestions + music brief</span>
          </p>
          <p className="text-text-secondary/70">
            Cloud vision and cloud transcription both stay a per-session opt-in
            (header checkboxes). The director model has its own picker in the
            Director panel. Stored under <code>{LAB_SETTINGS_KEY}</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
