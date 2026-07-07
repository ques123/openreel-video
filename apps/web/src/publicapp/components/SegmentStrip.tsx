/**
 * The screening room's segment strip (docs/wizz-ui-draft.html's .segstrip):
 * one thumbnail per shot; click jumps the playhead; hover/focus reveals the
 * director's one-line "why" for that pick — the wireframe's exact DOM shape
 * (a .why div immediately following the .frame button) is preserved because
 * the CSS relies on the adjacent-sibling selector for the reveal.
 */
import type { PublicCutSegment } from "../../publicflow/types";
import { cutRelativeRanges } from "../player-advance";
import { fmtDurationShort } from "../format";

export function SegmentStrip({
  segments,
  onJump,
}: {
  segments: PublicCutSegment[];
  onJump: (index: number) => void;
}) {
  const ranges = cutRelativeRanges(segments);
  return (
    <div className="segstrip-wrap">
      <div className="segstrip">
        {segments.map((seg, i) => {
          const t = fmtDurationShort(ranges[i]?.startS ?? 0);
          return (
            <div className="seg" key={`${seg.clipId}-${i}`}>
              <button
                className="frame"
                aria-label={`Shot at ${t} — why this shot?`}
                style={seg.thumbnailUrl ? { backgroundImage: `url(${seg.thumbnailUrl})` } : undefined}
                onClick={() => onJump(i)}
              />
              <div className="why">{seg.why}</div>
              <div className="t tc">{t}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
