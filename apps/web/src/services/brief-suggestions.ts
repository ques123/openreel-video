/**
 * Contextually-grounded brief suggestions: one-shot LLM call (same proxy the
 * director and music brief use) that reads a footage digest and proposes a
 * handful of genuinely different editorial angles for the director brief
 * textarea. Unlike generateMusicBrief there is NO heuristic fallback — a bad
 * angle is worse than none, so any failure throws and the UI surfaces it.
 */

import { BASE as OPENAI_BASE } from "./openai-proxy";

export interface BriefSuggestion {
  label: string;
  brief: string;
}

export const SUGGEST_BRIEFS_MODEL = "gpt-5.4-mini";

/** Labels are a short angle name, not a summary — truncate defensively for card UI. */
const MAX_LABEL_CHARS = 40;

/** Fewer than this many valid suggestions means the response isn't usable. */
const MIN_VALID_SUGGESTIONS = 2;

const SYSTEM_INSTRUCTIONS =
  "You propose editorial angles for a video director brief, grounded ONLY in the footage digest " +
  "given to you (never invent content that isn't named in it). Reply with STRICT JSON: " +
  '{"suggestions":[{"label":"...","brief":"..."}, ...]} with EXACTLY 4 entries.\n\n' +
  "Each entry's `label` is a short punchy angle name, 2-4 words (e.g. \"Slowness study\", " +
  '"Market feast"). Each entry\'s `brief` is ONE flowing 2-4 sentence director\'s brief — ' +
  "prose, not a bulleted list — that MUST: (a) open with a concrete hook naming something " +
  "actually present in the digest (a shot, a place, a moment, a line of dialogue), (b) include " +
  'at least one explicit exclusion (e.g. "no food shots", "skip the interviews"), (c) give a ' +
  "pacing instruction (e.g. quick cuts, lingering takes, building tempo), (d) say how the cut " +
  "should end, and (e) name a one-line theme tying it together. If a target cut length is given, " +
  "mention it naturally in the brief.\n\n" +
  "The 4 suggestions MUST take genuinely DIFFERENT editorial angles — different hooks, different " +
  "exclusions, different moods — not rephrasings of the same idea.";

interface RawSuggestion {
  label?: unknown;
  brief?: unknown;
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
    const { label, brief } = item;
    if (typeof label !== "string" || typeof brief !== "string") continue;
    const trimmedLabel = label.trim();
    const trimmedBrief = brief.trim();
    if (!trimmedLabel || !trimmedBrief) continue;
    suggestions.push({ label: trimmedLabel.slice(0, MAX_LABEL_CHARS), brief: trimmedBrief });
  }
  if (suggestions.length < MIN_VALID_SUGGESTIONS) {
    throw new Error("Brief suggestions: the model didn't return enough usable angles.");
  }
  return suggestions;
}

/** One-shot call: digest + optional target length in, 4 (or a few less) angle cards out. */
export async function suggestBriefs(
  digest: string,
  targetS: number | null,
  signal?: AbortSignal,
): Promise<BriefSuggestion[]> {
  const userLines = [
    digest,
    targetS != null ? `Target cut length: ~${Math.round(targetS)}s` : null,
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

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content ?? "";
  return parseSuggestions(raw);
}
