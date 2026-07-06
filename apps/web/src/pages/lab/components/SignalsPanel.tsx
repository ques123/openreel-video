import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AudioEnvelope,
  AudioEvent,
  CandidatePick,
  SelectionResult,
  SelectorConfig,
  Shot,
  ShotScore,
} from "@openreel/core";
import { isDefaultSelectorConfig } from "../selector-settings";
import type { LabClip } from "../use-perception-lab";
import { SelectorTuningPanel } from "./SelectorTuningPanel";

interface SignalsPanelProps {
  clips: LabClip[];
  selection: SelectionResult | null;
  onShotClick: (clip: LabClip, shot: Shot) => void;
  /** The user's saved (pre-preset) selector config — the tuning panel's source of truth. */
  selectorConfig: SelectorConfig;
  onSelectorConfigChange: (patch: Partial<SelectorConfig>) => void;
  onResetSelectorConfig: () => void;
  /** Non-null when a style preset is currently overriding the gate mode for selection. */
  presetOverrideNote: string | null;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

/**
 * Loudness envelope as vertical bars, event spans overlaid in amber. Pure
 * canvas redraw on data change; backing store is devicePixelRatio-scaled so
 * it stays crisp on hi-dpi displays.
 */
function AudioSparkline({ envelope, events }: { envelope: AudioEnvelope; events: AudioEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width || canvas.clientWidth || 1);
    const h = Math.max(1, rect.height || 32);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (envelope.rms.length === 0) return;
    const maxRms = Math.max(0.05, ...envelope.rms);
    const barW = w / envelope.rms.length;
    const inEvent = (t: number) => events.some((e) => t >= e.t && t <= e.t + e.durS);

    envelope.rms.forEach((v, i) => {
      const t = i * envelope.windowS;
      const barH = Math.max(1, (v / maxRms) * h);
      ctx.fillStyle = inEvent(t) ? "rgba(245,158,11,0.9)" : "rgba(136,136,136,0.4)";
      ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 0.5), barH);
    });
  }, [envelope, events]);

  return <canvas ref={canvasRef} className="w-full h-8 block" />;
}

function componentsCell(components: ShotScore["components"]): string {
  return (
    `m ${components.motion.toFixed(2)} ` +
    `a ${components.audio.toFixed(2)} ` +
    `s ${components.speech.toFixed(2)} ` +
    `æ ${components.aesthetic.toFixed(2)}`
  );
}

/** One clip's sparkline + shot-score table. */
function ClipSignals({
  clip,
  scores,
  picks,
  onShotClick,
}: {
  clip: LabClip;
  scores: Map<number, ShotScore> | undefined;
  picks: Map<number, CandidatePick> | undefined;
  onShotClick: (clip: LabClip, shot: Shot) => void;
}) {
  const statusLabel =
    clip.audioEvents === undefined
      ? "no audio signals yet"
      : clip.audioEvents.length > 0
        ? `${clip.audioEvents.length} loud moment${clip.audioEvents.length === 1 ? "" : "s"}`
        : "quiet audio";

  return (
    <div className="mb-3 last:mb-0">
      <p className="text-xs font-medium text-text-secondary mb-1 flex items-center justify-between gap-2">
        <span className="truncate">{clip.fileName}</span>
        <span className="font-normal shrink-0">{statusLabel}</span>
      </p>

      {clip.audioEnvelope && (
        <div className="mb-1.5">
          <AudioSparkline envelope={clip.audioEnvelope} events={clip.audioEvents ?? []} />
          <p className="text-[9px] text-text-secondary/60 mt-0.5">
            loudness · <span className="text-amber-500">▮</span> event
          </p>
        </div>
      )}

      <table className="w-full text-[10px] font-mono">
        <thead>
          <tr className="text-text-secondary text-left">
            <th className="font-normal pr-2">#</th>
            <th className="font-normal pr-2">time</th>
            <th className="font-normal pr-2">score</th>
            <th className="font-normal pr-2">components</th>
            <th className="font-normal">pick</th>
          </tr>
        </thead>
        <tbody className="text-text-primary">
          {clip.shots.map((shot) => {
            const score = scores?.get(shot.index);
            const pick = picks?.get(shot.index);
            const pct = score ? Math.round(score.score * 100) : 0;
            return (
              <tr
                key={shot.index}
                className={`cursor-pointer hover:bg-background ${score?.gated ? "opacity-50" : ""}`}
                onClick={() => onShotClick(clip, shot)}
              >
                <td className="pr-2 align-middle">#{shot.index}</td>
                <td className="pr-2 align-middle whitespace-nowrap">
                  {fmtTime(shot.tStart)}–{fmtTime(shot.tEnd)}
                </td>
                <td className="pr-2 align-middle">
                  <div className="flex items-center gap-1 min-w-20">
                    <span className="w-6 text-right shrink-0">{score ? pct : "—"}</span>
                    <div className="flex-1 h-1.5 bg-background rounded overflow-hidden">
                      <div
                        className={`h-full ${pick ? "bg-amber-500" : "bg-primary/40"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="pr-2 align-middle whitespace-nowrap">
                  {score ? componentsCell(score.components) : "—"}
                </td>
                <td className="align-middle whitespace-nowrap">
                  {pick ? (
                    <span
                      className="text-amber-500"
                      title={
                        pick.reasons.join(", ") +
                        (pick.uniquenessPenalty > 0
                          ? ` (uniqueness −${pick.uniquenessPenalty.toFixed(2)})`
                          : "")
                      }
                    >
                      ★C{pick.chapterIndex}.{pick.rank}
                    </span>
                  ) : score?.gated ? (
                    <span className="text-text-secondary/50" title={score.gateReasons.join("; ")}>
                      gated
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Visibility centerpiece for the signal-stack selector: every shot's
 * component scores, which ones got gated out and why, which became
 * candidates and why, plus the per-clip loudness sparkline the audio
 * component is computed from. Nothing here is decorative — it is all read
 * straight from the same SelectionResult the director's candidates mode and
 * candidates-only cloud enhance consume, so what the user sees here is
 * exactly what downstream steps acted on.
 */
export function SignalsPanel({
  clips,
  selection,
  onShotClick,
  selectorConfig,
  onSelectorConfigChange,
  onResetSelectorConfig,
  presetOverrideNote,
}: SignalsPanelProps) {
  const doneClips = useMemo(() => clips.filter((c) => c.status === "done"), [clips]);
  // Starts open when the persisted config is already non-default (so a
  // returning/tuned session shows its dials, not just a "tuned" pill), closed
  // otherwise to keep the panel compact. Deliberately not resynced after
  // mount — this is just the initial disclosure state.
  const [tuneOpen, setTuneOpen] = useState(() => !isDefaultSelectorConfig(selectorConfig));
  const tuned = !isDefaultSelectorConfig(selectorConfig);

  const scoresByClip = useMemo(() => {
    const m = new Map<string, Map<number, ShotScore>>();
    if (!selection) return m;
    for (const s of selection.scores) {
      let clipMap = m.get(s.clipId);
      if (!clipMap) {
        clipMap = new Map();
        m.set(s.clipId, clipMap);
      }
      clipMap.set(s.shotIndex, s);
    }
    return m;
  }, [selection]);

  const picksByClip = useMemo(() => {
    const m = new Map<string, Map<number, CandidatePick>>();
    if (!selection) return m;
    for (const p of selection.picks) {
      let clipMap = m.get(p.clipId);
      if (!clipMap) {
        clipMap = new Map();
        m.set(p.clipId, clipMap);
      }
      clipMap.set(p.shotIndex, p);
    }
    return m;
  }, [selection]);

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
          Signals & selection
          {tuned && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-mono border border-amber-500/60 text-amber-500 font-normal"
              title="Selector config differs from the shipped defaults"
            >
              tuned
            </span>
          )}
        </h3>
        <button
          type="button"
          onClick={() => setTuneOpen((o) => !o)}
          className="text-[10px] text-text-secondary hover:text-text-primary underline decoration-dotted shrink-0"
        >
          {tuneOpen ? "hide tuning" : "tune"}
        </button>
      </div>

      {tuneOpen && (
        <SelectorTuningPanel
          config={selectorConfig}
          onChange={onSelectorConfigChange}
          onReset={onResetSelectorConfig}
          presetOverrideNote={presetOverrideNote}
        />
      )}

      {!selection || doneClips.length === 0 ? (
        <p className="text-xs text-text-secondary">
          Every shot is scored from measurable signals — motion, loudness events, speech,
          sharpness — then the strongest per chapter become candidates ★. Signals appear as
          analysis finishes.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1 mb-3">
            {selection.chapters.map((chapter) => {
              const pickCount = selection.picks.filter(
                (p) => p.chapterIndex === chapter.index,
              ).length;
              return (
                <span
                  key={chapter.index}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                    pickCount > 0
                      ? "border-amber-500/60 text-amber-500"
                      : "border-border text-text-secondary"
                  }`}
                >
                  {chapter.label} · {pickCount} pick{pickCount === 1 ? "" : "s"}
                </span>
              );
            })}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {doneClips.map((clip) => (
              <ClipSignals
                key={clip.clipId}
                clip={clip}
                scores={scoresByClip.get(clip.clipId)}
                picks={picksByClip.get(clip.clipId)}
                onShotClick={onShotClick}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
