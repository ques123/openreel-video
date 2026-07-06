/**
 * Pure spend-guardrail logic for cloud enhance runs: the $ preview shown
 * before anything is sent, the (scope, model) "already enhanced" test the
 * bulk default-selection keys on, and the re-enhance impact assessment
 * (replacement + shrink detection) behind the confirm dialog. No React, no
 * network — everything here is unit-tested.
 */

import type { ClipDossier, CloudRunMeta, CloudScope } from "@openreel/core";
import { estimateCostUSD, fmtUSD } from "../../services/model-pricing";
import type { ModelChatUsage } from "../../services/openai-proxy";

/**
 * Measured per-frame token profile, from the 91-clip / 1,253-frame timeline
 * run in docs/captioning-cost-plan.md (251k prompt / 80k completion tokens ≈
 * 200 in / 65 out per frame, batch overhead included). Estimates only —
 * batch size and provider tokenizers shift these a few percent, so the
 * preview says "≈". Calibration is pinned by a test: these constants price
 * that measured run at ~$0.55 (gpt-5.4-mini) / ~$1.56 (gpt-5.2).
 */
export const EST_PROMPT_TOKENS_PER_FRAME = 200;
export const EST_COMPLETION_TOKENS_PER_FRAME = 65;

/**
 * A replacement counts as a SHRINK when it would send fewer than this
 * fraction of the archived run's frames — the "candidates-only re-run
 * silently gutting a full-timeline archive" case.
 */
export const SHRINK_RATIO = 0.5;

/** Per-clip frame plan summary (from planCloudFrames) feeding the preview. */
export interface ClipFramePlan {
  clipId: string;
  fileName: string;
  /** Frames that would actually be sent (post blur-gate/merge/cap). */
  frames: number;
  /** In-scope frames before the blur gate + similarity merge. */
  preMergeFrames: number;
}

export interface EnhanceCostPreview {
  clips: number;
  frames: number;
  preMergeFrames: number;
  /** null = model missing from the pricing table (never guessed). */
  estUSD: number | null;
}

/**
 * Aggregate cost preview for an enhance run. Frames are unique images, so no
 * prompt-cache discount is assumed (estimateCostUSD's cachedTokens arg stays
 * 0 — the preview can only overstate, never understate).
 */
export function estimateEnhanceCost(plans: ClipFramePlan[], model: string): EnhanceCostPreview {
  let frames = 0;
  let preMergeFrames = 0;
  for (const p of plans) {
    frames += p.frames;
    preMergeFrames += p.preMergeFrames;
  }
  return {
    clips: plans.length,
    frames,
    preMergeFrames,
    estUSD: estimateCostUSD(
      model,
      frames * EST_PROMPT_TOKENS_PER_FRAME,
      frames * EST_COMPLETION_TOKENS_PER_FRAME,
      0,
    ),
  };
}

/** "≈$0.42 · 340→212 frames" (arrow only when the merge actually saved frames). */
export function formatCostPreview(preview: EnhanceCostPreview): string {
  const frames =
    preview.preMergeFrames > preview.frames
      ? `${preview.preMergeFrames}→${preview.frames} frames`
      : `${preview.frames} frame${preview.frames === 1 ? "" : "s"}`;
  return preview.estUSD !== null ? `≈${fmtUSD(preview.estUSD)} · ${frames}` : frames;
}

/** The cloud-run fields this module reads (full ClipDossier satisfies it). */
export type CloudRunHistory = Pick<ClipDossier, "cloudRuns" | "cloudRunArchive">;

/**
 * Whether the clip already has an enhance run for THIS (scope, model)
 * combination — the "done" test bulk default-selection keys on. Checking the
 * scope alone (the old `cloudRuns[scope]` truthiness test) deselected clips
 * enhanced with a DIFFERENT model, silently skipping them when comparing
 * models. Reads the archive (one entry per scope+model) and falls back to
 * the current-run meta for legacy dossiers whose archive is missing.
 */
export function hasCloudRun(
  dossier: CloudRunHistory | null | undefined,
  scope: CloudScope,
  model: string,
): boolean {
  if (!dossier) return false;
  if ((dossier.cloudRunArchive ?? []).some((e) => e.scope === scope && e.model === model)) {
    return true;
  }
  return dossier.cloudRuns?.[scope]?.model === model;
}

/** The archived run a re-enhance of (scope, model) would replace, if any. */
function archivedRunMeta(
  dossier: CloudRunHistory,
  scope: CloudScope,
  model: string,
): CloudRunMeta | null {
  const entry = (dossier.cloudRunArchive ?? []).find(
    (e) => e.scope === scope && e.model === model,
  );
  if (entry) return entry.meta;
  const current = dossier.cloudRuns?.[scope];
  return current && current.model === model ? current : null;
}

/** One clip whose (scope, model) archive a re-enhance would replace. */
export interface ReEnhanceReplacement {
  clipId: string;
  fileName: string;
  /** framesSent of the archived run being replaced. */
  archivedFrames: number;
  /** Frames the new run would send. */
  plannedFrames: number;
}

export interface ReEnhanceImpact {
  /** Clips that already have a run for this exact (scope, model). */
  replacing: ReEnhanceReplacement[];
  /** Subset of `replacing` where the new run is materially smaller (< SHRINK_RATIO). */
  shrinking: ReEnhanceReplacement[];
}

export interface ReEnhanceTarget extends ClipFramePlan {
  dossier: CloudRunHistory | null;
}

/**
 * Which of the clips about to be enhanced would REPLACE an archived
 * (scope, model) run, and which of those replacements would materially
 * shrink the archive (e.g. a candidates-only re-run over a full-timeline
 * run) — rerunning a combination silently replaces its archive entry (see
 * applyCloudResults), so both deserve an explicit confirm.
 */
export function assessReEnhance(
  targets: ReEnhanceTarget[],
  scope: CloudScope,
  model: string,
): ReEnhanceImpact {
  const replacing: ReEnhanceReplacement[] = [];
  const shrinking: ReEnhanceReplacement[] = [];
  for (const t of targets) {
    if (!t.dossier) continue;
    const meta = archivedRunMeta(t.dossier, scope, model);
    if (!meta) continue;
    const replacement: ReEnhanceReplacement = {
      clipId: t.clipId,
      fileName: t.fileName,
      archivedFrames: meta.framesSent,
      plannedFrames: t.frames,
    };
    replacing.push(replacement);
    if (replacement.plannedFrames < replacement.archivedFrames * SHRINK_RATIO) {
      shrinking.push(replacement);
    }
  }
  return { replacing, shrinking };
}

/** How many example clips a confirm message lists before "+N more". */
const CONFIRM_EXAMPLE_LIMIT = 3;

/**
 * Confirm-dialog text for a run that would replace archived captions, or
 * null when nothing is replaced (no confirm needed — first-time enhances run
 * straight through). Folds in the shrink warning and the run's $ preview so
 * one dialog carries every guardrail.
 */
export function buildReEnhanceConfirm(
  impact: ReEnhanceImpact,
  scope: CloudScope,
  model: string,
  preview: EnhanceCostPreview,
): string | null {
  if (impact.replacing.length === 0) return null;
  const n = impact.replacing.length;
  const lines: string[] = [
    `${n} clip${n === 1 ? " already has" : "s already have"} a (${scope}, ${model}) enhance — ` +
      `re-running replaces ${n === 1 ? "its" : "their"} archived captions for that combination.`,
  ];
  if (impact.shrinking.length > 0) {
    const examples = impact.shrinking
      .slice(0, CONFIRM_EXAMPLE_LIMIT)
      .map((r) => `  ${r.fileName}: ${r.archivedFrames} → ${r.plannedFrames} frames`);
    const more = impact.shrinking.length - examples.length;
    lines.push(
      "",
      `⚠ ${impact.shrinking.length} replacement${impact.shrinking.length === 1 ? "" : "s"} ` +
        `would be much SMALLER than the archived run (a candidates-only re-run over a fuller archive?):`,
      ...examples,
      ...(more > 0 ? [`  …and ${more} more`] : []),
    );
  }
  lines.push("", `This run: ${formatCostPreview(preview)}. Continue?`);
  return lines.join("\n");
}

/** Session-scope aux LLM spend (brief suggestions, music brief). */
export interface AuxSpend {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Sum over entries with known pricing. */
  usd: number;
  /** Entries whose model has no pricing (their $ is excluded from `usd`). */
  unpricedCalls: number;
}

export function sumAuxSpend(entries: ModelChatUsage[]): AuxSpend {
  const spend: AuxSpend = {
    calls: entries.length,
    promptTokens: 0,
    completionTokens: 0,
    usd: 0,
    unpricedCalls: 0,
  };
  for (const u of entries) {
    spend.promptTokens += u.promptTokens;
    spend.completionTokens += u.completionTokens;
    const usd = estimateCostUSD(u.model, u.promptTokens, u.completionTokens, u.cachedTokens);
    if (usd === null) {
      spend.unpricedCalls += 1;
    } else {
      spend.usd += usd;
    }
  }
  return spend;
}

/** "$0.02 · 3 calls" — "≥" prefix when some calls had no known pricing. */
export function formatAuxSpend(spend: AuxSpend): string {
  const prefix = spend.unpricedCalls > 0 ? "≥" : "";
  return `${prefix}${fmtUSD(spend.usd)} · ${spend.calls} call${spend.calls === 1 ? "" : "s"}`;
}
