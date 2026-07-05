import type { LabClip, ModelStatus } from "../use-perception-lab";

interface PerfPanelProps {
  clips: LabClip[];
  models: { embed: ModelStatus; whisper: ModelStatus; captioner: ModelStatus };
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

  // Aggregate cloud usage per (model, scope) across ALL loaded clips, plus
  // the local caption pass — the "what has captioning cost me" ledger.
  const usage = new Map<
    string,
    { clips: number; frames: number; inTok: number; outTok: number; ms: number }
  >();
  let localMs = 0;
  let localFrames = 0;
  for (const c of clips) {
    if (c.dossier?.localCaptionPerf) {
      localMs += c.dossier.localCaptionPerf.totalMs;
      localFrames += c.dossier.localCaptionPerf.frames;
    }
    for (const e of c.dossier?.cloudRunArchive ?? []) {
      const key = `${e.model} · ${e.scope}`;
      const row = usage.get(key) ?? { clips: 0, frames: 0, inTok: 0, outTok: 0, ms: 0 };
      row.clips += 1;
      row.frames += e.meta.framesSent;
      row.inTok += e.meta.promptTokens;
      row.outTok += e.meta.completionTokens;
      row.ms += e.meta.ms;
      usage.set(key, row);
    }
  }
  const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const fmtDur = (ms: number) =>
    ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Performance</h3>

      <div className="space-y-1 mb-3">
        <ModelRow name="SigLIP2 (vision+text)" status={models.embed} />
        <ModelRow name="Whisper" status={models.whisper} />
        <ModelRow name="FastVLM (captions)" status={models.captioner} />
      </div>

      {(usage.size > 0 || localFrames > 0) && (
        <div className="mb-3">
          <p className="text-xs font-semibold text-text-primary mb-1">
            Captioning totals
            <span className="font-normal text-text-secondary ml-1">
              ({clips.length} loaded clip{clips.length === 1 ? "" : "s"})
            </span>
          </p>
          <table className="w-full text-[10px] font-mono">
            <thead>
              <tr className="text-text-secondary text-left">
                <th className="font-normal pr-2">run</th>
                <th className="font-normal pr-2 text-right">clips</th>
                <th className="font-normal pr-2 text-right">frames</th>
                <th className="font-normal pr-2 text-right">in</th>
                <th className="font-normal pr-2 text-right">out</th>
                <th className="font-normal text-right">time</th>
              </tr>
            </thead>
            <tbody className="text-text-primary">
              {localFrames > 0 && (
                <tr>
                  <td className="pr-2">local · timeline</td>
                  <td className="pr-2 text-right">—</td>
                  <td className="pr-2 text-right">{localFrames}</td>
                  <td className="pr-2 text-right">—</td>
                  <td className="pr-2 text-right">—</td>
                  <td className="text-right">{fmtDur(localMs)}</td>
                </tr>
              )}
              {[...usage.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, row]) => (
                  <tr key={key}>
                    <td className="pr-2">{key.replace("gpt-", "")}</td>
                    <td className="pr-2 text-right">{row.clips}</td>
                    <td className="pr-2 text-right">{row.frames}</td>
                    <td className="pr-2 text-right">{fmtTok(row.inTok)}</td>
                    <td className="pr-2 text-right">{fmtTok(row.outTok)}</td>
                    <td className="text-right">{fmtDur(row.ms)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

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
