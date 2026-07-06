/**
 * Story-voiced brief suggestions: one-shot LLM call (same proxy the director
 * and music brief use) that reads a footage digest and proposes a handful of
 * genuinely different narratives told in the owner's own voice, optionally
 * locked to a curated style preset. Unlike generateMusicBrief there is NO
 * heuristic fallback — a bad angle is worse than none, so any failure throws
 * and the UI surfaces it.
 */

import { stylePresetById, STYLE_PRESETS, type StylePreset } from "@openreel/core";
import {
  BASE as OPENAI_BASE,
  parseChatUsage,
  type ModelChatUsage,
  type RawChatUsage,
} from "./openai-proxy";

export interface BriefSuggestion {
  label: string;
  brief: string;
  styleId?: string;
}

export const SUGGEST_BRIEFS_MODEL = "gpt-5.4-mini";

/** Labels are a short angle name, not a summary — truncate defensively for card UI. */
const MAX_LABEL_CHARS = 40;

/** Fewer than this many valid suggestions means the response isn't usable. */
const MIN_VALID_SUGGESTIONS = 2;

/** How many distinct presets to sample when no style is locked. */
const UNLOCKED_STYLE_SAMPLE_SIZE = 4;

const SYSTEM_INSTRUCTIONS =
  "You suggest director briefs for someone editing their own footage. You are given a digest " +
  "of what is actually in their clips: scene descriptions, spoken lines, recording order. Read " +
  "it like a storyteller and find coherent narratives someone could tell WITH this footage — " +
  "then write each one as a brief in the owner's own voice.\n\n" +
  "Write like a human describing their video to a friend who will edit it: first person, warm, " +
  'concrete. This is the register (do NOT copy its content): "This is from our slow morning in ' +
  "Ayutthaya — start with us drifting on the river before the town wakes up. It wasn't about the " +
  "food that day, so leave the market eating out. Let shots breathe; don't rush it. End back at " +
  "the water as the light goes gold. It's a video about how good it feels when nothing is " +
  'happening."\n\n' +
  "Each brief should naturally contain: the moment to open on, something real in the footage to " +
  "leave out, how it should move, how it ends, and what it is really about — woven into the " +
  "story, never as a list or a form. 2-4 sentences each.\n\n" +
  "Hard rules:\n" +
  "- Ground everything in the digest. Never invent scenes, people or events that are not " +
  "evidenced there. Anything you exclude must actually appear in the footage.\n" +
  "- NEVER mention: file names, clip numbers or counts, durations in seconds, timestamps, shot " +
  'counts, camera brands or gear, or editing jargon (no "micro-clips", "held frame", "graphic ' +
  'overlays", "b-roll", "footage"). Talk about places, people, light and moments — the content, ' +
  "never the files.\n" +
  "- The suggestions must find genuinely different stories in the same footage — different " +
  "openings, different things left out, different meanings — not rephrasings.\n\n" +
  'Reply with STRICT JSON {"suggestions":[{"label":"...","brief":"...","styleId":"..."}]}, ' +
  "exactly 4 entries, label = short punchy angle name 2-4 words.";

interface RawSuggestion {
  label?: unknown;
  brief?: unknown;
  styleId?: unknown;
}

/** Parse + strictly validate the model's JSON. Throws with a short human message on any failure. */
function parseSuggestions(raw: string): BriefSuggestion[] {
  let parsed: { suggestions?: unknown };
  try {
    parsed = JSON.parse(raw) as { suggestions?: unknown };
  } catch {
    throw new Error("Brief suggestions: the model returned invalid JSON.");
  }
  const list = Array.isArray(parsed.suggestions) ? (parsed.suggestions as RawSuggestion[]) : [];
  const suggestions: BriefSuggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { label, brief, styleId } = item;
    if (typeof label !== "string" || typeof brief !== "string") continue;
    const trimmedLabel = label.trim();
    const trimmedBrief = brief.trim();
    if (!trimmedLabel || !trimmedBrief) continue;
    const suggestion: BriefSuggestion = {
      label: trimmedLabel.slice(0, MAX_LABEL_CHARS),
      brief: trimmedBrief,
    };
    // styleId is optional and only kept when it names a known preset — a
    // hallucinated id is worse than none, but doesn't invalidate the brief.
    if (typeof styleId === "string" && stylePresetById(styleId)) {
      suggestion.styleId = styleId;
    }
    suggestions.push(suggestion);
  }
  if (suggestions.length < MIN_VALID_SUGGESTIONS) {
    throw new Error("Brief suggestions: the model didn't return enough usable angles.");
  }
  return suggestions;
}

/** `n` distinct presets in random order (Math.random is fine — this is UI variety, not security). */
function sampleDistinctPresets(n: number): StylePreset[] {
  const pool = [...STYLE_PRESETS];
  const picked: StylePreset[] = [];
  while (picked.length < n && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool[i]);
    pool.splice(i, 1);
  }
  return picked;
}

/**
 * Locked style: every brief must be told in that voice. No locked style:
 * sample distinct presets and assign one per brief so the cards double as a
 * style sampler.
 */
function buildStyleInstruction(style: StylePreset | null): string {
  if (style) {
    return (
      `Write all 4 briefs in this style — ${style.label}: ${style.directorNote} ` +
      `Set styleId to "${style.id}" on every entry. The 4 must still find genuinely different stories.`
    );
  }
  const sampled = sampleDistinctPresets(UNLOCKED_STYLE_SAMPLE_SIZE);
  const list = sampled.map((p) => `- ${p.id}: ${p.label} — ${p.directorNote}`).join("\n");
  return `Write each brief in a different one of these styles (one each; echo that style's styleId):\n${list}`;
}

/**
 * One-shot call: digest + optional target length + style lock (or null to
 * vary styles across cards) in, 4 (or a few less) story-voiced cards out.
 * `onUsage` reports the real billed usage — invoked BEFORE response parsing
 * so a malformed reply still lands in cost accounting (billed is billed).
 */
export async function suggestBriefs(
  digest: string,
  targetS: number | null,
  style: StylePreset | null,
  signal?: AbortSignal,
  onUsage?: (usage: ModelChatUsage) => void,
): Promise<BriefSuggestion[]> {
  const userLines = [
    digest,
    targetS != null ? `Target cut length: ~${Math.round(targetS)}s` : null,
    buildStyleInstruction(style),
  ].filter((l): l is string => Boolean(l));

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SUGGEST_BRIEFS_MODEL,
      messages: [
        { role: "system", content: SYSTEM_INSTRUCTIONS },
        { role: "user", content: userLines.join("\n\n") },
      ],
      response_format: { type: "json_object" },
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brief suggestions request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: RawChatUsage;
  };
  const usage = parseChatUsage(data.usage);
  if (usage) onUsage?.({ ...usage, model: SUGGEST_BRIEFS_MODEL });
  const raw = data.choices?.[0]?.message?.content ?? "";
  return parseSuggestions(raw);
}
