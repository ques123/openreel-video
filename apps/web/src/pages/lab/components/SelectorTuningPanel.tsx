import { useState } from "react";
import { DEFAULT_SELECTOR_CONFIG, type SelectorConfig, type SharpnessGateMode } from "@openreel/core";
import { formatKeywordsInput, parseKeywordsInput } from "../selector-settings";

interface SelectorTuningPanelProps {
  /** The user's saved (pre-preset) selector config — what this panel edits. */
  config: SelectorConfig;
  onChange: (patch: Partial<SelectorConfig>) => void;
  onReset: () => void;
  /** Non-null when a style preset is currently overriding the gate mode for selection. */
  presetOverrideNote: string | null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Compact labeled number input. Only commits on a VALID number
 * (`valueAsNumber`) — a bare "0." mid-typed reads as NaN, so the parent's
 * state (and this input's controlled `value`) is left alone until the user
 * finishes typing a real number. Committing on every keystroke of a partial
 * value would otherwise snap "0." back to "0" on the next render (the
 * classic controlled-number-input papercut), erasing the decimal point the
 * user just typed.
 */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  title,
  disabled,
  integer,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  title?: string;
  disabled?: boolean;
  integer?: boolean;
  onCommit: (v: number) => void;
}) {
  return (
    <label
      className="flex items-center justify-between gap-2 text-[11px] text-text-secondary"
      title={title}
    >
      <span className={disabled ? "opacity-40" : undefined}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.valueAsNumber;
          if (Number.isNaN(raw)) return;
          onCommit(clamp(integer ? Math.round(raw) : raw, min, max));
        }}
        className="w-16 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-text-primary outline-none focus:border-primary disabled:opacity-40"
      />
    </label>
  );
}

/**
 * The signal-stack selector's full tuning surface (signal-score.ts
 * SelectorConfig) — the only per-footage-type dial the admin has. Edits are
 * live: selectCandidates is pure and cheap, so every change here recomputes
 * candidates immediately — filmstrip stars, this same panel's table,
 * candidates-only enhance scoping, and (when promptMode is "candidates")
 * the director's own picks all read the resulting SelectionResult.
 */
export function SelectorTuningPanel({
  config,
  onChange,
  onReset,
  presetOverrideNote,
}: SelectorTuningPanelProps) {
  // Local echo of the keywords text, decoupled from `config.keywords`: if the
  // input were derived straight from formatKeywordsInput(config.keywords), a
  // just-typed trailing comma (parsed away to nothing until the next word
  // starts) would immediately vanish on re-render, making a second keyword
  // impossible to type. Reset is the one place config changes WITHOUT the
  // user editing this input, so the reset button resyncs it explicitly below.
  const [keywordsText, setKeywordsText] = useState(() => formatKeywordsInput(config.keywords));
  const penalize = config.gate.sharpnessMode === "penalize";

  const setWeight = (key: keyof SelectorConfig["weights"], v: number) =>
    onChange({ weights: { ...config.weights, [key]: v } });
  const setGate = (patch: Partial<SelectorConfig["gate"]>) =>
    onChange({ gate: { ...config.gate, ...patch } });

  return (
    <div className="mb-3 border border-border rounded-md p-2 space-y-2 bg-background/40">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <NumberField
          label="w·motion"
          value={config.weights.motion}
          min={0}
          max={1}
          step={0.05}
          title="Shot motion score weight"
          onCommit={(v) => setWeight("motion", v)}
        />
        <NumberField
          label="w·audio"
          value={config.weights.audio}
          min={0}
          max={1}
          step={0.05}
          title="Audio event overlap/intensity weight"
          onCommit={(v) => setWeight("audio", v)}
        />
        <NumberField
          label="w·speech"
          value={config.weights.speech}
          min={0}
          max={1}
          step={0.05}
          title="Speech presence + keyword-hit weight"
          onCommit={(v) => setWeight("speech", v)}
        />
        <NumberField
          label="w·æsthetic"
          value={config.weights.aesthetic}
          min={0}
          max={1}
          step={0.05}
          title="Sharpness-based aesthetic tiebreak weight"
          onCommit={(v) => setWeight("aesthetic", v)}
        />

        <NumberField
          label="min sharpness"
          value={config.gate.minSharpness}
          min={0}
          max={200}
          step={1}
          title="Laplacian variance floor for a shot's rep frame — below this fails the sharpness gate"
          onCommit={(v) => setGate({ minSharpness: v })}
        />
        <NumberField
          label="min shot s"
          value={config.gate.minShotS}
          min={0}
          max={10}
          step={0.1}
          title="Minimum shot duration, seconds — always a hard gate"
          onCommit={(v) => setGate({ minShotS: v })}
        />
        <NumberField
          label="chapter gap m"
          value={config.chapterGapMinutes}
          min={1}
          max={180}
          step={1}
          title="recordedAt gap between consecutive clips that starts a new chapter, minutes"
          onCommit={(v) => onChange({ chapterGapMinutes: v })}
        />
        <NumberField
          label="top/chapter"
          value={config.topPerChapter}
          min={1}
          max={20}
          step={1}
          integer
          title="Candidates to pick per chapter, before uniqueness pruning"
          onCommit={(v) => onChange({ topPerChapter: v })}
        />
        <NumberField
          label="uniqueness"
          value={config.uniquenessPenalty}
          min={0}
          max={1}
          step={0.05}
          title="Penalty × max embedding-cosine to already-picked shots; 0 disables"
          onCommit={(v) => onChange({ uniquenessPenalty: v })}
        />
        <NumberField
          label="soft-focus penalty"
          value={config.gate.softFocusPenalty}
          min={0}
          max={1}
          step={0.05}
          disabled={!penalize}
          title="Max composite-score deduction for a below-threshold shot in 'penalize' mode"
          onCommit={(v) => setGate({ softFocusPenalty: v })}
        />
      </div>

      <label className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
        <span>blurry shots</span>
        <select
          value={config.gate.sharpnessMode}
          onChange={(e) => setGate({ sharpnessMode: e.target.value as SharpnessGateMode })}
          className="bg-background border border-border rounded px-1 py-0.5 text-[11px] text-text-primary outline-none focus:border-primary"
          title="exclude = hard gate, never picked. penalize = stays a candidate, docked by the soft-focus penalty"
        >
          <option value="exclude">exclude</option>
          <option value="penalize">penalize</option>
        </select>
      </label>

      {presetOverrideNote && <p className="text-[10px] text-amber-500">{presetOverrideNote}</p>}

      <label className="block text-[11px] text-text-secondary">
        <span>keywords</span>
        <input
          type="text"
          value={keywordsText}
          onChange={(e) => {
            setKeywordsText(e.target.value);
            onChange({ keywords: parseKeywordsInput(e.target.value) });
          }}
          placeholder="e.g. birthday, cake, surprise"
          className="mt-0.5 w-full bg-background border border-border rounded px-1.5 py-1 text-[11px] text-text-primary placeholder:text-text-secondary/50 outline-none focus:border-primary"
        />
        <span className="block mt-0.5 text-[9px] text-text-secondary/70">
          a transcript match boosts that shot&rsquo;s speech component to max
        </span>
      </label>

      <button
        type="button"
        onClick={() => {
          setKeywordsText(formatKeywordsInput(DEFAULT_SELECTOR_CONFIG.keywords));
          onReset();
        }}
        className="text-[10px] text-text-secondary hover:text-text-primary underline decoration-dotted"
      >
        reset to defaults
      </button>
    </div>
  );
}
