import { useState } from "react";
import type { SearchHit } from "@openreel/core";

interface SearchPanelProps {
  hits: SearchHit[];
  searching: boolean;
  ready: boolean;
  onSearch: (query: string) => void;
  onHitClick: (hit: SearchHit) => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function SearchPanel({ hits, searching, ready, onSearch, onHitClick }: SearchPanelProps) {
  const [query, setQuery] = useState("");

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-3">
      <h3 className="text-sm font-semibold text-text-primary mb-2">
        Find b-roll in your footage
      </h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(query);
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ready ? 'e.g. "waterfall", "people eating"' : "waiting for CLIP model…"}
          disabled={!ready}
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary/60 outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={!ready || searching}
          className="px-3 py-1.5 text-sm rounded-md bg-primary text-white disabled:opacity-40"
        >
          {searching ? "…" : "Search"}
        </button>
      </form>

      {hits.length > 0 && (
        <ul className="mt-3 space-y-1.5 max-h-80 overflow-y-auto">
          {hits.filter((h) => h.confident).length === 0 && (
            <li className="text-xs text-text-secondary py-1">
              No confident matches — closest shots below:
            </li>
          )}
          {hits.map((hit, i) => {
            const prev = hits[i - 1];
            const showDivider = prev?.confident && !hit.confident;
            return (
              <li key={`${hit.clipId}-${hit.shot.index}`}>
                {showDivider && (
                  <p className="text-[10px] uppercase tracking-wide text-text-secondary/60 pt-2 pb-1">
                    — weaker (probably not it) —
                  </p>
                )}
                <div
                  className={`flex items-center gap-2 p-1 rounded-md hover:bg-background cursor-pointer ${
                    hit.confident ? "" : "opacity-45"
                  }`}
                  onClick={() => onHitClick(hit)}
                >
                  <span className="text-xs text-text-secondary w-4 text-right">{i + 1}</span>
                  <img
                    src={hit.shot.thumbnailDataUrl}
                    alt=""
                    className="w-16 aspect-video object-cover rounded bg-black"
                    draggable={false}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-text-primary truncate">{hit.fileName}</p>
                    <p className="text-[10px] text-text-secondary font-mono">
                      {fmtTime(hit.shot.tStart)}–{fmtTime(hit.shot.tEnd)}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-mono ${hit.confident ? "text-primary" : "text-text-secondary"}`}
                  >
                    {hit.score.toFixed(2)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
