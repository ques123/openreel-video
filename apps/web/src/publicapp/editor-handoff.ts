/**
 * "Open in editor" handoff: builds a real, editable Storyboard from the
 * screening room's PublicCut and hands it to the existing compile-storyboard
 * service + project store — the exact seam the lab uses to land in a
 * hand-editable multi-track cut (services/compile-storyboard.ts). One-way by
 * construction: this only WRITES into the project store and lets the caller
 * navigate; nothing here reads state back out of the editor.
 *
 * PublicCutSegment (publicflow/types.ts) deliberately carries less than a
 * core StoryboardItem — no fileName/role/shotIndex/thumbnailDataUrl.
 * compileStoryboardTimeline (packages/core/src/analysis/compile-timeline.ts)
 * only actually reads `clipId`/`inS`/`outS` off each item — role, fileName,
 * shotIndex, and thumbnailDataUrl are cosmetic-only on that path — so a
 * faithful shim built from the public vocabulary is safe here.
 */
import type { Storyboard, TranscriptSegment } from "@openreel/core";
import { compileStoryboardToProject } from "../services/compile-storyboard";
import type { PublicCut } from "../publicflow/types";

function cutToStoryboard(cut: PublicCut, fileNameOf: (clipId: string) => string): Storyboard {
  return {
    title: cut.title,
    notes: null,
    items: cut.segments.map((seg) => ({
      clipId: seg.clipId,
      fileName: fileNameOf(seg.clipId),
      shotIndex: null,
      inS: seg.inS,
      outS: seg.outS,
      role: "cut",
      why: seg.why,
      thumbnailDataUrl: null,
    })),
  };
}

export interface OpenInEditorParams {
  cut: PublicCut;
  getFile: (clipId: string) => File | null;
  fileNameOf: (clipId: string) => string;
  /** The currently-selected music take (already resolved from PublicCut.musicTakes a/b), if any. */
  music?: { audioUrl: string; durationS: number } | null;
  transcriptOf?: (clipId: string) => TranscriptSegment[] | undefined;
  onProgress?: (line: string) => void;
}

export interface OpenInEditorResult {
  ok: boolean;
  missing?: string[];
  error?: string;
  warning?: string;
}

export async function openCutInEditor(params: OpenInEditorParams): Promise<OpenInEditorResult> {
  const storyboard = cutToStoryboard(params.cut, params.fileNameOf);
  const result = await compileStoryboardToProject({
    storyboard,
    getFile: params.getFile,
    music: params.music ?? null,
    transcriptOf: params.transcriptOf,
    onProgress: params.onProgress ?? (() => {}),
  });
  if (!result.ok) return { ok: false, missing: result.missing, error: result.error };
  return { ok: true, warning: result.warning };
}
