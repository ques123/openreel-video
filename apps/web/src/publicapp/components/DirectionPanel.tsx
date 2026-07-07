/**
 * The bench's direction panel (docs/wizz-ui-draft.html's .direction): style
 * cards (unselected = director's choice), the story brief, length chips +
 * custom, the music toggle, and the Generate button — the public product's
 * ENTIRE settings surface (plan §2).
 */
import { useState } from "react";
import { fmtChipLabel, fmtEtaLeft } from "../format";
import { useFlow } from "../flow-context";

export function DirectionPanel() {
  const { config, cutRequest, setCutRequest, pipeline, actions } = useFlow();
  const [useCustom, setUseCustom] = useState(false);
  const [customLen, setCustomLen] = useState("");

  if (!config) return null;

  const genNote = pipeline.allReady
    ? "≈ a minute, cut on this machine + a little direction in the cloud"
    : pipeline.batch
      ? `ready when your footage is understood — ${fmtEtaLeft(pipeline.batch.etaS ?? 0)}`
      : "ready when your footage is understood";

  return (
    <div className="card direction">
      <div className="sect">
        <span className="label">Style</span>
        <div className="styles">
          {config.styles.map((s) => (
            <button
              key={s.id}
              type="button"
              className="style-card"
              aria-pressed={cutRequest.styleId === s.id}
              onClick={() => setCutRequest({ styleId: cutRequest.styleId === s.id ? null : s.id })}
            >
              <div className="nm">{s.label}</div>
              <div className="tg">{s.tagline}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="sect">
        <span className="label">The story</span>
        <textarea
          className="brief"
          placeholder="What's this film about? Anything to feature, anything to leave out? (optional)"
          value={cutRequest.brief}
          onChange={(e) => setCutRequest({ brief: e.target.value })}
        />
      </div>

      <div className="sect">
        <span className="label">Length</span>
        <div className="lengths">
          {config.durationChips.map((s) => (
            <button
              key={s}
              type="button"
              className="len"
              aria-pressed={!useCustom && cutRequest.targetS === s}
              onClick={() => {
                setUseCustom(false);
                setCutRequest({ targetS: s });
              }}
            >
              {fmtChipLabel(s)}
            </button>
          ))}
          {config.allowCustomDuration && (
            <button
              type="button"
              className="len"
              aria-pressed={useCustom}
              onClick={() => setUseCustom(true)}
            >
              custom
            </button>
          )}
          {useCustom && (
            <input
              type="number"
              className="len-custom"
              min={config.minTargetS}
              max={config.maxTargetS}
              placeholder="sec"
              value={customLen}
              onChange={(e) => {
                setCustomLen(e.target.value);
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) {
                  setCutRequest({ targetS: Math.min(config.maxTargetS, Math.max(config.minTargetS, n)) });
                }
              }}
            />
          )}
        </div>
      </div>

      <div className="sect">
        <label className="toggle">
          <input
            type="checkbox"
            checked={cutRequest.music}
            onChange={(e) => setCutRequest({ music: e.target.checked })}
          />
          <span>Compose an original track to match the cut</span>
        </label>
      </div>

      <button
        className="btn btn-primary btn-generate"
        disabled={!pipeline.allReady}
        onClick={actions.generate}
      >
        Generate my cut
      </button>
      <p className="gen-note">{genNote}</p>
    </div>
  );
}
