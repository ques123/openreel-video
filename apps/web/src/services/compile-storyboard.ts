/**
 * Compile a director storyboard into a REAL editable project: import each
 * distinct source file into a fresh project's media library (real decode
 * metadata, thumbnails, IndexedDB persistence), build the timeline with the
 * pure core helper, and load it in one atomic step — the user lands in
 * #/editor with a hand-editable multi-track cut.
 *
 * Missing source files block the compile BEFORE the project store is touched
 * (no half-built project); a failing music fetch/import is non-fatal — the
 * cut compiles without its bed.
 */

import { compileStoryboardTimeline, type Storyboard } from "@openreel/core";
import { useProjectStore } from "../stores/project-store";

export interface CompileContext {
  storyboard: Storyboard;
  getFile: (clipId: string) => File | null;
  /** Pre-proxied audio URL + duration of the committed music track; null/absent = no music. */
  music?: { audioUrl: string; durationS: number } | null;
  onProgress: (line: string) => void;
}

export async function compileStoryboardToProject(
  ctx: CompileContext,
): Promise<
  { ok: true; warning?: string } | { ok: false; missing: string[]; error?: string }
> {
  const { storyboard, getFile, music, onProgress } = ctx;

  // Resolve every DISTINCT source clip (items reuse clips — dedup by clipId)
  // up front, so a missing file blocks before any store mutation.
  const files = new Map<string, File>();
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const item of storyboard.items) {
    if (seen.has(item.clipId)) continue;
    seen.add(item.clipId);
    const file = getFile(item.clipId);
    if (file) files.set(item.clipId, file);
    else if (!missing.includes(item.fileName)) missing.push(item.fileName);
  }
  if (missing.length > 0) return { ok: false, missing };

  useProjectStore.getState().createNewProject(storyboard.title ?? "Directed cut");

  const mediaIds = new Map<string, string>();
  const entries = [...files.entries()];
  for (let i = 0; i < entries.length; i += 1) {
    const [clipId, file] = entries[i];
    onProgress(`importing ${i + 1}/${entries.length}: ${file.name}…`);
    const result = await useProjectStore.getState().importMedia(file);
    if (!result.success || !result.actionId) {
      return {
        ok: false,
        missing: [],
        error: `import failed for ${file.name}: ${result.error?.message ?? "unknown error"}`,
      };
    }
    mediaIds.set(clipId, result.actionId);
  }

  // Music bed: fetch → File → import. Non-fatal — a dead proxy or a decode
  // error downgrades to a music-less compile rather than losing the cut.
  let musicOpt: { mediaId: string; durationS: number } | undefined;
  let warning: string | undefined;
  if (music) {
    onProgress("importing music…");
    try {
      const res = await fetch(music.audioUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], "music.mp3", { type: blob.type || "audio/mpeg" });
      const result = await useProjectStore.getState().importMedia(file);
      if (!result.success || !result.actionId) {
        throw new Error(result.error?.message ?? "import failed");
      }
      // Suno's durationS metadata is untrusted (can be 0 or overshoot) —
      // prefer the real decoded duration from the just-imported media item.
      const decoded = useProjectStore
        .getState()
        .project.mediaLibrary.items.find((i) => i.id === result.actionId)?.metadata.duration;
      const durationS = decoded && decoded > 0 ? decoded : music.durationS;
      if (durationS <= 0) throw new Error("zero-length audio");
      musicOpt = { mediaId: result.actionId, durationS };
    } catch (err) {
      console.error("[compile-storyboard] music import failed", err);
      warning = `music failed (${err instanceof Error ? err.message : String(err)}) — compiled without it`;
      onProgress(`${warning}…`);
    }
  }

  onProgress("building timeline…");
  const { tracks, duration } = compileStoryboardTimeline(
    storyboard,
    (clipId) => mediaIds.get(clipId)!,
    musicOpt ? { music: musicOpt } : undefined,
  );
  const store = useProjectStore.getState();
  store.loadProject({
    ...store.project,
    timeline: { tracks, subtitles: [], duration, markers: [] },
    // Explicit empties so loadProject clears the session-singleton title and
    // graphics engines — otherwise a prior session's titles/shapes leak in.
    textClips: [],
    shapeClips: [],
    svgClips: [],
    stickerClips: [],
  });
  return warning ? { ok: true, warning } : { ok: true };
}
