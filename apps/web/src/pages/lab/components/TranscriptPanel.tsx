import type { TranscriptSegment } from "@openreel/core";
import type { LabClip } from "../use-perception-lab";

interface TranscriptPanelProps {
  clips: LabClip[];
  onSegmentClick: (clip: LabClip, segment: TranscriptSegment) => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function TranscriptPanel({ clips, onSegmentClick }: TranscriptPanelProps) {
  const withTranscript = clips.filter((c) => c.transcript.length > 0);

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Transcript</h3>
      {withTranscript.length === 0 ? (
        <p className="text-xs text-text-secondary">
          No speech transcribed yet. Whisper runs on each clip's audio as it's analyzed.
        </p>
      ) : (
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {withTranscript.map((clip) => (
            <div key={clip.clipId}>
              <p className="text-xs font-medium text-text-secondary mb-1 truncate">
                {clip.fileName}
              </p>
              <ul className="space-y-0.5">
                {clip.transcript.map((seg, i) => (
                  <li
                    key={i}
                    className="text-xs text-text-primary leading-relaxed hover:bg-background rounded px-1 py-0.5 cursor-pointer"
                    onClick={() => onSegmentClick(clip, seg)}
                  >
                    <span className="font-mono text-text-secondary mr-1.5">
                      {fmtTime(seg.t0)}
                    </span>
                    {seg.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
