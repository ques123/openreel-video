/**
 * One footage row on the bench (docs/wizz-ui-draft.html's .clip): thumb,
 * name, per-clip stage bar, duration, remove — plus the plain-words error +
 * retry the wireframe describes in prose (§10 scene 2) but doesn't draw a
 * pixel for, since its simulation never actually fails a clip.
 */
import type { PublicClip } from "../../publicflow/types";
import { fmtDurationShort } from "../format";

export function ClipRow({
  clip,
  onRemove,
  onRetry,
}: {
  clip: PublicClip;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const durationLabel = clip.durationS !== null ? fmtDurationShort(clip.durationS) : null;

  let mid: JSX.Element;
  if (clip.status.kind === "ready") {
    mid = (
      <div className="stage">
        <span className="chip ok">ready</span>
      </div>
    );
  } else if (clip.status.kind === "analyzing") {
    const { stageLabel, progress, pass } = clip.status;
    mid = (
      <div className="stage">
        <span>
          {stageLabel}
          {pass && ` — pass ${pass.current}/${pass.total}`}
        </span>
        <span className="bar">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      </div>
    );
  } else if (clip.status.kind === "error") {
    mid = (
      <div className="stage">
        <span className="chip err">error</span>
        <span className="err-msg">{clip.status.message}</span>
      </div>
    );
  } else {
    mid = <div className="stage">waiting its turn</div>;
  }

  return (
    <div className="card clip">
      <div
        className="thumb"
        style={clip.thumbnailUrl ? { backgroundImage: `url(${clip.thumbnailUrl})` } : undefined}
      />
      <div className="meta">
        <div className="name">{clip.name}</div>
        {mid}
      </div>
      <div className="right">
        {durationLabel && <span className="tc">{durationLabel}</span>}
        {clip.status.kind === "error" && clip.status.retryable && (
          <button className="btn-quiet" style={{ padding: "2px 6px" }} onClick={onRetry}>
            retry
          </button>
        )}
        <button
          className="btn-quiet"
          title="Remove"
          aria-label={`Remove ${clip.name}`}
          style={{ padding: "2px 6px" }}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
