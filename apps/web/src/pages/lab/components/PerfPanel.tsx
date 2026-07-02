import type { LabClip, ModelStatus } from "../use-perception-lab";

interface PerfPanelProps {
  clips: LabClip[];
  models: { clip: ModelStatus; whisper: ModelStatus };
}

function ModelRow({ name, status }: { name: string; status: ModelStatus }) {
  const files = Object.values(status.files);
  const loaded = files.reduce((sum, [l]) => sum + l, 0);
  const total = files.reduce((sum, [, t]) => sum + t, 0);
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-text-secondary">{name}</span>
      <span className="font-mono text-text-primary">
        {status.state === "idle" && "—"}
        {status.state === "downloading" &&
          (total > 0 ? `${((loaded / total) * 100).toFixed(0)}% of ${(total / 1e6).toFixed(0)}MB` : "downloading…")}
        {status.state === "ready" &&
          `${status.device} · ${(status.loadMs / 1000).toFixed(1)}s load`}
        {status.state === "error" && "failed"}
      </span>
    </div>
  );
}

export function PerfPanel({ clips, models }: PerfPanelProps) {
  const done = clips.filter((c) => c.dossier && !c.dossier.perf.cacheHit);

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Performance</h3>

      <div className="space-y-1 mb-3">
        <ModelRow name="CLIP (vision+text)" status={models.clip} />
        <ModelRow name="Whisper" status={models.whisper} />
      </div>

      {done.length > 0 && (
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr className="text-text-secondary text-left">
              <th className="font-normal pr-2">clip</th>
              <th className="font-normal pr-2 text-right">ingest</th>
              <th className="font-normal pr-2 text-right">decode</th>
              <th className="font-normal pr-2 text-right">×RT</th>
              <th className="font-normal pr-2 text-right">embed/f</th>
              <th className="font-normal pr-2 text-right">whisper</th>
              <th className="font-normal text-right">total</th>
            </tr>
          </thead>
          <tbody className="text-text-primary">
            {done.map((c) => {
              const p = c.dossier!.perf;
              return (
                <tr key={c.clipId}>
                  <td className="pr-2 truncate max-w-24" title={c.fileName}>
                    {c.fileName}
                  </td>
                  <td className="pr-2 text-right" title={p.usedOpfs ? "OPFS scratch" : "direct blob reads"}>
                    {p.usedOpfs ? `${(p.ingestMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="pr-2 text-right">{(p.decodeMs / 1000).toFixed(1)}s</td>
                  <td className="pr-2 text-right">{p.realtimeFactor.toFixed(1)}</td>
                  <td className="pr-2 text-right">{p.embedPerFrameMs.toFixed(0)}ms</td>
                  <td className="pr-2 text-right">{(p.whisperMs / 1000).toFixed(1)}s</td>
                  <td className="text-right">{(p.totalMs / 1000).toFixed(1)}s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
