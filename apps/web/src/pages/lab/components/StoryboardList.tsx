import { storyboardDurationS, type Storyboard } from "@openreel/core";

interface StoryboardListProps {
  storyboard: Storyboard;
  warnings: string[];
  targetDurationS: number | null;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onPlay: () => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

export function StoryboardList({
  storyboard,
  warnings,
  targetDurationS,
  onRemove,
  onMove,
  onPlay,
}: StoryboardListProps) {
  const total = storyboardDurationS(storyboard);
  const offTarget =
    targetDurationS !== null && Math.abs(total - targetDurationS) / targetDurationS > 0.1;

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-text-primary truncate">
          {storyboard.title ?? "Storyboard"}
        </h3>
        <button
          onClick={onPlay}
          className="px-3 py-1 text-sm rounded-md bg-primary text-white shrink-0"
        >
          ▶ Play
        </button>
      </div>
      {storyboard.notes && (
        <p className="text-xs text-text-secondary mb-2">{storyboard.notes}</p>
      )}

      <ul className="space-y-1.5">
        {storyboard.items.map((item, i) => (
          <li key={`${item.clipId}-${i}`} className="flex items-center gap-2 p-1 rounded-md">
            <span className="text-xs text-text-secondary w-4 text-right">{i + 1}</span>
            {item.thumbnailDataUrl ? (
              <img
                src={item.thumbnailDataUrl}
                alt=""
                className="w-16 aspect-video object-cover rounded bg-black"
                draggable={false}
              />
            ) : (
              <div className="w-16 aspect-video rounded bg-black/40" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs text-text-primary truncate">
                <span className="text-primary font-medium">{item.role}</span> · {item.fileName}
              </p>
              <p className="text-[10px] text-text-secondary font-mono">
                {fmtTime(item.inS)}–{fmtTime(item.outS)} ({(item.outS - item.inS).toFixed(1)}s)
              </p>
              {item.why && (
                <p className="text-[10px] text-text-secondary/80 truncate" title={item.why}>
                  {item.why}
                </p>
              )}
            </div>
            <div className="flex flex-col shrink-0">
              <button
                onClick={() => onMove(i, i - 1)}
                disabled={i === 0}
                className="text-text-secondary hover:text-text-primary disabled:opacity-20 text-xs px-1"
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                onClick={() => onMove(i, i + 1)}
                disabled={i === storyboard.items.length - 1}
                className="text-text-secondary hover:text-text-primary disabled:opacity-20 text-xs px-1"
                aria-label="Move down"
              >
                ↓
              </button>
            </div>
            <button
              onClick={() => onRemove(i)}
              className="text-text-secondary hover:text-red-400 text-sm px-1 shrink-0"
              aria-label="Remove segment"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <p
        className={`text-xs font-mono mt-2 ${offTarget ? "text-amber-500" : "text-text-secondary"}`}
      >
        total {total.toFixed(1)}s
        {targetDurationS !== null && ` · target ${targetDurationS.toFixed(0)}s`}
      </p>

      {warnings.length > 0 && (
        <details className="mt-1">
          <summary className="text-[10px] text-text-secondary cursor-pointer">
            {warnings.length} note{warnings.length === 1 ? "" : "s"} from validation
          </summary>
          <ul className="mt-1 space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i} className="text-[10px] text-text-secondary/80">
                {w}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
