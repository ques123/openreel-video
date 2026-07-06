import { useState } from "react";
import {
  deleteAllExperimentVideos,
  deleteAllExperiments,
} from "../../../services/experiments";
import {
  clearDossierCache,
  clearOpfsScratch,
  measureStorageBreakdown,
  type CategoryUsage,
  type StorageBreakdown,
} from "../../../services/storage-breakdown";
import { ConfirmButton } from "./ConfirmButton";

/** 1_234_567 -> "1.2MB"; sub-kB values matter here (index records). */
function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}kB`;
  return `${n}B`;
}

interface RowSpec {
  key: string;
  label: string;
  usage: CategoryUsage;
  /** Undefined = measured for context only, no scoped clear offered. */
  clear?: () => Promise<unknown>;
  note: string;
}

/**
 * Per-category storage ledger with scoped, confirmed clears — the previous
 * UI was one shrinking origin-wide number whose only remedy was the app-wide
 * clearAllData(). Measurement walks every cache record (videos included) to
 * read sizes, so it runs on demand behind a button, never automatically.
 */
export function StorageBreakdownSection() {
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const measure = () => {
    setMeasuring(true);
    void measureStorageBreakdown()
      .then(setBreakdown)
      .catch(() => setBreakdown(null))
      .finally(() => setMeasuring(false));
  };

  const runClear = (key: string, clear: () => Promise<unknown>) => {
    setBusy(key);
    void clear()
      .catch(() => undefined)
      .then(() => measureStorageBreakdown())
      .then(setBreakdown)
      .catch(() => undefined)
      .finally(() => setBusy(null));
  };

  if (!breakdown) {
    return (
      <button
        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
        onClick={measure}
        disabled={measuring}
        title="Size each storage category (dossiers, experiments, rendered videos, OPFS scratch). Reads every cached record — can take a moment when videos are stored."
      >
        {measuring ? "measuring…" : "measure breakdown"}
      </button>
    );
  }

  const rows: RowSpec[] = [
    {
      key: "dossiers",
      label: "dossier cache",
      usage: breakdown.cache.dossiers,
      clear: clearDossierCache,
      note: "cached analysis (all pipeline versions) — clips re-analyze on next drop",
    },
    {
      key: "experiments",
      label: "experiments",
      usage: breakdown.cache.experiments,
      clear: deleteAllExperiments,
      note: "ALL run records — also deletes their rendered videos",
    },
    {
      key: "experimentVideos",
      label: "rendered videos",
      usage: breakdown.cache.experimentVideos,
      clear: deleteAllExperimentVideos,
      note: "debug renders only — runs are kept and re-render on demand",
    },
    {
      key: "otherCache",
      label: "other cache",
      usage: breakdown.cache.otherCache,
      note: "editor frame caches etc. — no scoped clear here",
    },
  ];
  const scratch = breakdown.opfsScratch;

  return (
    <div>
      <table className="w-full text-[10px] font-mono">
        <tbody className="text-text-primary">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="pr-2 text-text-secondary" title={r.note}>
                {r.label}
              </td>
              <td className="pr-2 text-right">{r.usage.count}</td>
              <td className="pr-2 text-right">{fmtBytes(r.usage.bytes)}</td>
              <td className="text-right w-14">
                {r.clear && (
                  <ConfirmButton
                    className="px-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                    armedClassName="bg-red-500/10"
                    confirmLabel="sure?"
                    disabled={busy !== null || r.usage.count === 0}
                    title={r.note}
                    onConfirm={() => runClear(r.key, r.clear!)}
                  >
                    {busy === r.key ? "…" : "clear"}
                  </ConfirmButton>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td
              className="pr-2 text-text-secondary"
              title="funnel workers' scratch copies of clips being analyzed (perception-scratch)"
            >
              OPFS scratch
            </td>
            {scratch ? (
              <>
                <td className="pr-2 text-right">{scratch.count}</td>
                <td
                  className="pr-2 text-right"
                  title={
                    scratch.partial
                      ? "some files are locked by a running analysis — this is a lower bound"
                      : undefined
                  }
                >
                  {fmtBytes(scratch.bytes)}
                  {scratch.partial ? "+" : ""}
                </td>
                <td className="text-right w-14">
                  <ConfirmButton
                    className="px-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                    armedClassName="bg-red-500/10"
                    confirmLabel="sure?"
                    disabled={busy !== null || scratch.count === 0}
                    title="delete scratch files — entries locked by a running analysis are skipped"
                    onConfirm={() => runClear("scratch", clearOpfsScratch)}
                  >
                    {busy === "scratch" ? "…" : "clear"}
                  </ConfirmButton>
                </td>
              </>
            ) : (
              <td className="text-right text-text-secondary" colSpan={3}>
                unavailable
              </td>
            )}
          </tr>
        </tbody>
      </table>
      {scratch?.partial && (
        <p className="text-[10px] text-text-secondary/60">
          scratch sizes marked “+” are a lower bound — files locked by a running analysis
          could not be measured
        </p>
      )}
      <button
        className="mt-1 text-[10px] px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-40"
        onClick={measure}
        disabled={measuring || busy !== null}
      >
        {measuring ? "measuring…" : "re-measure"}
      </button>
    </div>
  );
}
