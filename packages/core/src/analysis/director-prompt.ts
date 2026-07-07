/**
 * Prompt construction for the director: dossier -> compact text the LLM can
 * reason over, the system prompt (persona + craft + data caveats), and the
 * formatters for tool results fed back into the conversation.
 *
 * Everything here is pure string building — no I/O, no model calls — so it
 * is fully unit-testable and the exact bytes sent to the LLM are auditable.
 */

import { mergeDenseCaptions } from "./caption-text";
import type { SearchResult } from "./retrieval";
import type { SelectionResult } from "./signal-score";
import type {
  ClipDossier,
  CloudRunArchiveEntry,
  DenseCaption,
  Shot,
  TranscriptSegment,
} from "./types";
import { storyboardDurationS, type Storyboard } from "./director-types";

/** Per-clip transcript budget; talky clips get truncated, not dropped. */
const DEFAULT_MAX_TRANSCRIPT_CHARS = 8000;
/** Per-clip scene-timeline budget (merged segments, not raw captions). */
const DEFAULT_MAX_TIMELINE_CHARS = 8000;

const fmtS = (s: number) => s.toFixed(1);

/** Deterministic "2026-06-24 05:42 UTC" — only relative order matters. */
const fmtRecordedAt = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * Which perception sources feed the director prompt — the A/B mixer.
 * localCaptions covers both per-shot descriptions and the local scene
 * timeline; the two cloud variants and the transcript toggle independently.
 */
export interface PromptSources {
  localCaptions: boolean;
  cloudShots: boolean;
  cloudTimeline: boolean;
  transcript: boolean;
  /**
   * Pin a scope to a specific archived caption model (e.g. "gpt-5.4-mini").
   * Unset = the clip's latest run for that scope. Clips lacking the pinned
   * run fall back to their latest, per clip.
   */
  cloudShotsModel?: string;
  cloudTimelineModel?: string;
  /**
   * How footage reaches the director. "full" (default) = every clip's full
   * scene timeline. "candidates" = the signal-stack selector's scored
   * top-picks per chapter, plus one-line gists of everything else so quiet
   * moments stay visible and the model can still pull any shot.
   */
  promptMode?: "full" | "candidates";
  /**
   * Which transcript variant the prompt carries when `transcript` is on
   * (mirrors the caption model pins above). "local" (default) = the
   * always-computed in-browser whisper pass (dossier.transcript). "cloud" =
   * the opt-in Groq run (dossier.cloudTranscript) — clips lacking a cloud
   * run fall back to local, per clip, and the prompt names the source
   * either way so the conversation inspector shows exactly what was sent.
   */
  transcriptSource?: "local" | "cloud";
}

export const DEFAULT_PROMPT_SOURCES: PromptSources = {
  localCaptions: true,
  cloudShots: true,
  cloudTimeline: true,
  transcript: true,
};

/** CLIP header line + (when applicable) the PARTIAL-analysis warning. */
function renderClipHeader(dossier: ClipDossier): string[] {
  const lines: string[] = [
    `CLIP ${dossier.clipId} "${dossier.fileName}"  duration ${fmtS(dossier.durationS)}s  ${dossier.width}x${dossier.height}` +
      (dossier.recordedAt !== null ? `  recorded ${fmtRecordedAt(dossier.recordedAt)}` : ""),
  ];
  if (dossier.analyzedThroughS !== null) {
    lines.push(
      `  !! PARTIAL: analyzed only through ${fmtS(dossier.analyzedThroughS)}s — ` +
        `shots/transcript below cover [0, ${fmtS(dossier.analyzedThroughS)}s]; do not reference later times.`,
    );
  }
  return lines;
}

/** The archived (scope, model) run to pin to, or undefined for "use latest". */
function findPinnedRun(
  dossier: ClipDossier,
  scope: "shots" | "timeline",
  model: string | undefined,
): CloudRunArchiveEntry | undefined {
  return model
    ? dossier.cloudRunArchive.find((e) => e.scope === scope && e.model === model)
    : undefined;
}

/** Nearest pinned-run caption to a shot's rep frame, or null when none overlaps. */
function pinnedCaptionForShot(
  run: CloudRunArchiveEntry | undefined,
  shot: Pick<Shot, "tStart" | "tEnd" | "repFrameTime">,
): string | null {
  if (!run) return null;
  let best: DenseCaption | null = null;
  for (const c of run.captions) {
    if (c.t < shot.tStart - 1 || c.t > shot.tEnd + 1) continue;
    if (!best || Math.abs(c.t - shot.repFrameTime) < Math.abs(best.t - shot.repFrameTime)) {
      best = c;
    }
  }
  return best?.text ?? null;
}

/**
 * Caption-preference logic shared by every renderer: cloud pin > cloudCaption
 * > local caption, honoring the source mixer's on/off toggles.
 */
function shotCaptionText(
  shot: Shot,
  sources: PromptSources,
  pinnedShotsRun: CloudRunArchiveEntry | undefined,
): string | null {
  return (
    (sources.cloudShots ? (pinnedCaptionForShot(pinnedShotsRun, shot) ?? shot.cloudCaption) : null) ??
    (sources.localCaptions ? shot.caption : null)
  );
}

/**
 * Resolves which transcript segments a clip contributes to the prompt, per
 * the `transcriptSource` mixer (see its doc comment on PromptSources — this
 * function IS that contract): "local" (default) always uses the
 * always-computed `dossier.transcript`. "cloud" uses `dossier.cloudTranscript`
 * when this clip has one, falling back to local — labeled as a fallback — when
 * it does not. Every branch returns a `label` so callers can name the source
 * inline (the conversation inspector must always show what was actually sent).
 *
 * Empty-cloud edge: a clip whose `cloudTranscript` exists but recorded ZERO
 * segments (the cloud pass ran and heard no speech) is still a CLOUD hit —
 * its (empty) segments are returned as-is, not swapped for local. Falling
 * back there would misrepresent what the cloud run actually heard.
 */
export function resolveTranscript(
  dossier: ClipDossier,
  sources: PromptSources,
): { segments: TranscriptSegment[]; label: string } {
  if (sources.transcriptSource === "cloud") {
    if (dossier.cloudTranscript) {
      return {
        segments: dossier.cloudTranscript.segments,
        label: `cloud ${dossier.cloudTranscript.model}`,
      };
    }
    return { segments: dossier.transcript, label: "local whisper (cloud not run for this clip)" };
  }
  return { segments: dossier.transcript, label: "local whisper" };
}

/**
 * Transcript section: withheld / no-speech / timecoded lines, budget-capped.
 * The header names the resolved source (local vs cloud, see resolveTranscript)
 * so the exact bytes sent to the LLM are auditable in the conversation
 * inspector.
 */
function renderTranscript(
  dossier: ClipDossier,
  sources: PromptSources,
  maxTranscriptChars: number,
): string[] {
  const lines: string[] = [];
  if (!sources.transcript) {
    lines.push("  TRANSCRIPT: (withheld for this run — work from the visuals)");
    return lines;
  }
  const { segments, label } = resolveTranscript(dossier, sources);
  if (segments.length === 0) {
    lines.push(`  TRANSCRIPT (${label}): (no speech detected)`);
  } else {
    lines.push(`  TRANSCRIPT (${label}):`);
    let used = 0;
    for (const seg of segments) {
      const line = `    [${fmtS(seg.t0)}-${fmtS(seg.t1)}] ${seg.text.trim()}`;
      if (used + line.length > maxTranscriptChars) {
        lines.push("    [transcript truncated]");
        break;
      }
      lines.push(line);
      used += line.length;
    }
  }
  return lines;
}

export function dossierToPromptText(
  dossier: ClipDossier,
  opts: { maxTranscriptChars?: number; sources?: PromptSources } = {},
): string {
  const maxTranscriptChars = opts.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const sources = opts.sources ?? DEFAULT_PROMPT_SOURCES;
  const lines: string[] = [...renderClipHeader(dossier)];

  lines.push(
    "  SHOTS (index  start-end  len  motion(0-255, <40 typical)  peak@  sharpness(~200+ = sharp)  scene description):",
  );
  const pinnedShots = findPinnedRun(dossier, "shots", sources.cloudShotsModel);
  for (const shot of dossier.shots) {
    const len = shot.tEnd - shot.tStart;
    // Cloud descriptions (opt-in enhance, large model) trump local ones —
    // subject to the source mixer (and its model pin, when set).
    const text = shotCaptionText(shot, sources, pinnedShots);
    const maxLen = 240;
    const caption = text
      ? `  "${text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text}"`
      : "";
    lines.push(
      `    #${shot.index}  ${fmtS(shot.tStart)}-${fmtS(shot.tEnd)}s  ${fmtS(len)}s  ` +
        `motion ${Math.round(shot.motion.score)} peak@${fmtS(shot.motion.peakTime)}  ` +
        `sharp ${Math.round(shot.quality.sharpness)}${caption}`,
    );
  }

  const pinnedTimeline = sources.cloudTimelineModel
    ? dossier.cloudRunArchive.find(
        (e) => e.scope === "timeline" && e.model === sources.cloudTimelineModel,
      )
    : undefined;
  const cloudTimelineCaptions = pinnedTimeline?.captions ?? dossier.cloudDenseCaptions;
  const cloudTimelineModel =
    pinnedTimeline?.model ?? dossier.cloudRuns.timeline?.model ?? "cloud";
  const useCloudTimeline = sources.cloudTimeline && cloudTimelineCaptions.length > 0;
  const timeline = useCloudTimeline
    ? cloudTimelineCaptions
    : sources.localCaptions
      ? dossier.denseCaptions
      : [];
  if (timeline.length > 0) {
    const segments = mergeDenseCaptions(timeline);
    lines.push(
      useCloudTimeline
        ? `  SCENE TIMELINE (CLOUD-ENHANCED by ${cloudTimelineModel} — large vision model, considerably more reliable; sampled on visual change, similar neighbors merged):`
        : `  SCENE TIMELINE (machine descriptions sampled on visual change, similar neighbors merged):`,
    );
    let used = 0;
    for (const seg of segments) {
      const range =
        seg.t1 > seg.t0 ? `[${fmtS(seg.t0)}-${fmtS(seg.t1)}]` : `[${fmtS(seg.t0)}]`;
      const line = `    ${range} ${seg.text}`;
      if (used + line.length > DEFAULT_MAX_TIMELINE_CHARS) {
        lines.push("    [timeline truncated]");
        break;
      }
      lines.push(line);
      used += line.length;
    }
  }

  lines.push(...renderTranscript(dossier, sources, maxTranscriptChars));

  return lines.join("\n");
}

/** Chronological copy: known recording times first (oldest→newest), unknown last. */
export function sortByRecordedAt(dossiers: ClipDossier[]): ClipDossier[] {
  return [...dossiers].sort(
    (a, b) => (a.recordedAt ?? Infinity) - (b.recordedAt ?? Infinity),
  );
}

export function dossiersToPromptText(
  dossiers: ClipDossier[],
  sources?: PromptSources,
): string {
  return sortByRecordedAt(dossiers)
    .map((d) => dossierToPromptText(d, { sources }))
    .join("\n\n");
}

export function buildSystemPrompt(): string {
  return `You are a video editor's director. You receive machine analysis ("dossiers") of raw clips: shot boundaries with motion and sharpness metrics, a machine-written scene description per shot, and a timecoded speech transcript. You have NOT seen the pixels. The scene descriptions tell you what each shot shows; use the search_shots tool (text-to-image embedding retrieval) to verify pivotal picks or find things the descriptions may have missed.

TOOLS
- search_shots(query, topK): use short caption-style visual queries ("a person cutting open a durian", not "durian cutting scene analysis"). Results carry a "confident" flag: confident hits clearly separate from the rest of the footage and are trustworthy; non-confident hits are weak — corroborate them (transcript, motion, another query) or avoid building key moments on them. No confident hits usually means the footage does not contain it; do not force it.
- submit_storyboard(...): call exactly once, when the cut is decided. "in"/"out" are seconds within the clip; prefer trimming inside one shot's boundaries; every item needs a role and a one-line "why". If the submission is rejected with errors, fix them and resubmit.

EDITING CRAFT
- Open with a hook: the strongest 2-4 seconds (high motion, striking visual, or a compelling spoken line) — earn attention before giving context.
- Vary pacing: alternate segment lengths; high-motion shots can run shorter, calm scenic shots slightly longer. Avoid two near-identical shots back to back.
- Prefer sharp shots (sharpness ~200+; higher is sharper). Motion is mean frame difference on a 0-255 scale, typically under 40: ~25+ is energetic, single digits is static. The peak@ time marks the liveliest moment — useful when trimming.
- Cut speech on sentence boundaries using the transcript timings; never clip mid-word. Silence between segments is fine.
- Respect chronology: clips carry recording times and are listed oldest-first. A montage reads as a story — by default keep segments in recording order so the viewer experiences the trip the way it happened. Deliberate exceptions are fine (e.g. pulling ONE strong later moment forward as the hook, then running chronologically), but never shuffle time arbitrarily.
- Hit the target duration within ±10%. Add up your segment durations BEFORE submitting.

DATA CAVEATS
- Scene descriptions are written by a small local vision model from single frames: reliable for scene gist, subject, action and mood, but they can miss small objects, miss things happening between sampled frames, and state wrong details confidently. Corroborate the shots your cut depends on with search_shots.
- Sections marked CLOUD-ENHANCED come from a large vision model and are considerably more reliable — trust them over metrics when they disagree.
- The transcript comes from Whisper and hallucinates on non-speech or non-English audio: repeated loops ("check, check, check…"), stray phrases over music or wind. Distrust repetitive or context-free lines; treat them as no-speech.
- A clip marked PARTIAL was only analyzed through the stated time; never select ranges beyond it.
- Metrics are heuristics, not ground truth: use them to rank candidates, not as facts to assert.

PROCESS
Read the brief and dossiers — the scene descriptions ARE the footage as far as you can see it; plan the arc (hook -> development -> payoff) from them, the transcript, and the metrics. Then run a few targeted searches to verify your pivotal picks or hunt for anything the descriptions might have missed, and submit. Be decisive — you have a limited number of tool rounds.`;
}

export function buildBriefMessage(brief: string, targetDurationS: number | null): string {
  const lines = ["BRIEF: " + brief.trim()];
  if (targetDurationS !== null) {
    lines.push(`TARGET DURATION: ${fmtS(targetDurationS)}s (stay within ±10%)`);
  }
  return lines.join("\n");
}

export function buildDossierMessage(
  dossiers: ClipDossier[],
  sources?: PromptSources,
): string {
  return (
    `FOOTAGE: ${dossiers.length} analyzed clip${dossiers.length === 1 ? "" : "s"} — ` +
    `this is ALL the available footage, listed in RECORDING ORDER (oldest first).\n\n` +
    dossiersToPromptText(dossiers, sources)
  );
}

/**
 * Candidates-mode footage message: chapters with the selector's scored
 * top-picks rendered in full detail (timecodes, captions per the sources
 * mixer, score + reasons), followed by a compact one-line-per-shot GIST list
 * of ALL remaining shots (so nothing is invisible), plus transcripts per the
 * sources mixer. Same RECORDING ORDER guarantees as buildDossierMessage;
 * explains to the model that picks are heuristic suggestions, not commands,
 * and any gist shot may be pulled instead.
 */
/** Per-clip gist budget; talky/busy clips get truncated, not dropped. */
const DEFAULT_MAX_GIST_CHARS = 4000;

export function buildCandidatesMessage(
  dossiers: ClipDossier[],
  selection: SelectionResult,
  sources?: PromptSources,
): string {
  const src = sources ?? DEFAULT_PROMPT_SOURCES;
  const sorted = sortByRecordedAt(dossiers);
  const dossierById = new Map(sorted.map((d) => [d.clipId, d]));
  const key = (clipId: string, shotIndex: number) => `${clipId}#${shotIndex}`;
  const pickedKeys = new Set(selection.picks.map((p) => key(p.clipId, p.shotIndex)));
  const scoreByKey = new Map(selection.scores.map((s) => [key(s.clipId, s.shotIndex), s]));

  const lines: string[] = [];
  lines.push(
    `FOOTAGE: ${dossiers.length} analyzed clip${dossiers.length === 1 ? "" : "s"} — listed in ` +
      `RECORDING ORDER (oldest first). A signal-stack selector (motion, loudness events, speech, ` +
      `sharpness, visual uniqueness) scored every shot and picked the strongest candidates per ` +
      `chapter (a chapter = a stretch of recording time). Candidate picks are HEURISTIC ` +
      `suggestions — strong hooks/peaks the metrics can see. The GIST lists cover every remaining ` +
      `shot; quiet-but-meaningful moments live there. You may build your cut from ANY shot in ` +
      `either list.`,
  );

  for (const chapter of selection.chapters) {
    lines.push("");
    lines.push(`CHAPTER ${chapter.index}: ${chapter.label}`);
    lines.push("  CANDIDATES:");
    const picks = selection.picks
      .filter((p) => p.chapterIndex === chapter.index)
      .sort((a, b) => a.rank - b.rank);
    if (picks.length === 0) {
      lines.push("    (none — every shot in this chapter was gated out)");
    }
    for (const pick of picks) {
      const dossier = dossierById.get(pick.clipId);
      const shot = dossier?.shots.find((s) => s.index === pick.shotIndex);
      if (!dossier || !shot) continue;
      const len = shot.tEnd - shot.tStart;
      const uniqueness =
        pick.uniquenessPenalty > 0 ? `  (uniqueness −${pick.uniquenessPenalty.toFixed(2)})` : "";
      lines.push(
        `  ★C${pick.chapterIndex}.${pick.rank}  CLIP ${pick.clipId} "${dossier.fileName}" shot #${shot.index}  ` +
          `${fmtS(shot.tStart)}-${fmtS(shot.tEnd)}s  ${fmtS(len)}s  motion ${Math.round(shot.motion.score)} ` +
          `peak@${fmtS(shot.motion.peakTime)}  sharp ${Math.round(shot.quality.sharpness)}  ` +
          `score ${pick.finalScore.toFixed(2)}${uniqueness}  why: ${pick.reasons.join(", ")}`,
      );
      const pinnedShots = findPinnedRun(dossier, "shots", src.cloudShotsModel);
      const captionText = shotCaptionText(shot, src, pinnedShots);
      if (captionText) {
        lines.push(`    "${captionText}"`);
      }
      if (src.transcript) {
        const { segments } = resolveTranscript(dossier, src);
        const overlapping = segments.filter(
          (seg) => seg.t0 < shot.tEnd && seg.t1 > shot.tStart,
        );
        for (const seg of overlapping.slice(0, 2)) {
          lines.push(`    [${fmtS(seg.t0)}-${fmtS(seg.t1)}] ${seg.text.trim()}`);
        }
      }
    }
  }

  lines.push("");
  lines.push("ALL SHOTS (gist):");
  for (const dossier of sorted) {
    lines.push("");
    lines.push(...renderClipHeader(dossier));
    const pinnedShots = findPinnedRun(dossier, "shots", src.cloudShotsModel);
    let used = 0;
    for (const shot of dossier.shots) {
      const captionText = shotCaptionText(shot, src, pinnedShots);
      const maxLen = 100;
      const caption = captionText
        ? `  "${captionText.length > maxLen ? captionText.slice(0, maxLen - 3) + "..." : captionText}"`
        : "";
      const score = scoreByKey.get(key(dossier.clipId, shot.index));
      const gatedSuffix = score?.gated ? `  [gated: ${score.gateReasons.join("; ")}]` : "";
      const star = pickedKeys.has(key(dossier.clipId, shot.index)) ? "★" : " ";
      const line =
        `  ${star}#${shot.index}  ${fmtS(shot.tStart)}-${fmtS(shot.tEnd)}s  ` +
        `motion ${Math.round(shot.motion.score)} sharp ${Math.round(shot.quality.sharpness)}${caption}${gatedSuffix}`;
      if (used + line.length > DEFAULT_MAX_GIST_CHARS) {
        lines.push("  [gist truncated]");
        break;
      }
      lines.push(line);
      used += line.length;
    }
  }

  lines.push("");
  lines.push("TRANSCRIPTS:");
  for (const dossier of sorted) {
    lines.push("");
    lines.push(...renderClipHeader(dossier));
    lines.push(...renderTranscript(dossier, src, DEFAULT_MAX_TRANSCRIPT_CHARS));
  }

  return lines.join("\n");
}

export function formatSearchResults(query: string, result: SearchResult): string {
  if (result.hits.length === 0) {
    return `search_shots("${query}"): no shots with embeddings yet.`;
  }
  const lines = [
    `search_shots("${query}") — ${result.hits.length} hits ` +
      `(population mean ${result.mean.toFixed(3)}, std ${result.std.toFixed(3)}):`,
  ];
  for (const hit of result.hits) {
    const s = hit.shot;
    lines.push(
      `  ${hit.confident ? "CONFIDENT" : "weak     "}  score ${hit.score.toFixed(3)}  ` +
        `clip ${hit.clipId} shot #${s.index}  ${fmtS(s.tStart)}-${fmtS(s.tEnd)}s  ` +
        `motion ${Math.round(s.motion.score)}  sharp ${Math.round(s.quality.sharpness)}`,
    );
  }
  if (!result.hits.some((h) => h.confident)) {
    lines.push("  (no confident hits — the footage likely does not contain this)");
  }
  return lines.join("\n");
}

export function formatValidationFeedback(errors: string[], warnings: string[]): string {
  const lines = ["Storyboard REJECTED — fix these and call submit_storyboard again:"];
  for (const e of errors) lines.push(`  - ${e}`);
  if (warnings.length > 0) {
    lines.push("Also note (not blocking):");
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

/**
 * Refine message: embeds the CURRENT storyboard (including any manual removes
 * or reorders the user made in the UI since the last submit) so the model
 * revises what the user actually sees, not what it last submitted.
 */
export function buildRefineMessage(
  feedback: string,
  current: Storyboard,
  targetDurationS: number | null = null,
): string {
  const items = current.items.map((it) => ({
    clipId: it.clipId,
    shotIndex: it.shotIndex,
    in: Number(it.inS.toFixed(1)),
    out: Number(it.outS.toFixed(1)),
    role: it.role,
    why: it.why,
  }));
  return (
    `The user reviewed the storyboard (possibly edited — this is the current state, ` +
    `total ${fmtS(storyboardDurationS(current))}s):\n` +
    JSON.stringify({ title: current.title, items }, null, 1) +
    `\n\nUSER FEEDBACK: ${feedback.trim()}\n` +
    (targetDurationS !== null
      ? `TARGET DURATION is now ${fmtS(targetDurationS)}s (stay within ±10%).\n`
      : "") +
    `Revise the storyboard accordingly (search more if needed) and submit_storyboard again.`
  );
}
