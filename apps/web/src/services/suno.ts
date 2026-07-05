/**
 * Suno music generation client (sunoapi.org, V5 custom-mode, instrumental).
 * Same-origin proxy pattern as openai-proxy.ts: calls go to /api/proxy/suno/*
 * — nginx on abacus rewrites to https://api.sunoapi.org/api/v1 and injects
 * the API key server-side, so no key ever exists in the browser.
 *
 * Flow: generateMusicBrief() (LLM, falls back to the pure heuristic in
 * @openreel/core on any failure) -> startMusicGeneration() kicks off an async
 * job -> pollMusicTask() until it lands two track variations.
 */

import {
  buildMusicBriefFallback,
  clampMusicBrief,
  type MusicBrief,
  type Storyboard,
} from "@openreel/core";
import { BASE as OPENAI_BASE } from "./openai-proxy";

export const BASE = "/api/proxy/suno";

/** Callback the sunoapi.org job posts to on completion (unused client-side; we poll). */
const CALLBACK_URL = "https://openreel.pbrain.dev/api/suno-callback";

/** One-shot brief-writer model — cheap, fast, strict JSON only. */
const BRIEF_MODEL = "gpt-5.4-mini";

interface SunoEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

export interface SunoTrack {
  id: string;
  audioUrl: string;
  streamAudioUrl: string;
  imageUrl: string;
  title: string;
  modelName: string;
  durationS: number;
  tags: string;
}

export type MusicTaskStatus = "pending" | "partial" | "ready" | "failed";

const FAILED_STATUSES = new Set([
  "CREATE_TASK_FAILED",
  "GENERATE_AUDIO_FAILED",
  "CALLBACK_EXCEPTION",
  "SENSITIVE_WORD_ERROR",
]);

/**
 * Tolerant field mapping. Verified against a real record-info response
 * (2026-07-05): tracks live at data.response.sunoData, duration arrives as a
 * STRING ("129.8"), audioUrl is on tempfile.aiquickdraw.com and streamAudioUrl
 * on musicfile.removeai.ai.
 */
function toSunoTrack(raw: Record<string, unknown>): SunoTrack {
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    audioUrl: typeof raw.audioUrl === "string" ? raw.audioUrl : "",
    streamAudioUrl: typeof raw.streamAudioUrl === "string" ? raw.streamAudioUrl : "",
    imageUrl: typeof raw.imageUrl === "string" ? raw.imageUrl : "",
    title: typeof raw.title === "string" ? raw.title : "",
    modelName: typeof raw.modelName === "string" ? raw.modelName : "",
    durationS: Number(raw.duration) || 0,
    tags: typeof raw.tags === "string" ? raw.tags : "",
  };
}

/** Kick off generation. Returns the taskId to poll. */
export async function startMusicGeneration(brief: MusicBrief): Promise<string> {
  const res = await fetch(`${BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customMode: true,
      instrumental: true,
      model: "V5",
      style: brief.style,
      title: brief.title,
      prompt: brief.prompt,
      callBackUrl: CALLBACK_URL,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`suno generate ${res.status}: ${body.slice(0, 300)}`);
  }
  const envelope = (await res.json()) as SunoEnvelope<{ taskId?: string }>;
  if (envelope.code !== 200) {
    throw new Error(envelope.msg || `suno generate failed (code ${envelope.code})`);
  }
  const taskId = envelope.data?.taskId;
  if (!taskId) throw new Error("suno generate: response had no taskId");
  return taskId;
}

export interface MusicTaskResult {
  status: MusicTaskStatus;
  tracks: SunoTrack[];
  errorMessage: string | null;
}

/** Poll a generation task. Two track variations land once status is "ready". */
export async function pollMusicTask(taskId: string): Promise<MusicTaskResult> {
  const res = await fetch(`${BASE}/generate/record-info?taskId=${encodeURIComponent(taskId)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`suno record-info ${res.status}: ${body.slice(0, 300)}`);
  }
  const envelope = (await res.json()) as SunoEnvelope<{
    status?: string;
    response?: { sunoData?: Record<string, unknown>[] };
    sunoData?: Record<string, unknown>[];
    errorMessage?: string;
  }>;
  if (envelope.code !== 200) {
    return { status: "failed", tracks: [], errorMessage: envelope.msg || `code ${envelope.code}` };
  }

  const data = envelope.data ?? {};
  const rawStatus = data.status ?? "PENDING";
  // Parse tolerantly: nesting under data.response.sunoData is the documented
  // shape but data.sunoData has also been observed.
  const rawTracks = data.response?.sunoData ?? data.sunoData ?? [];
  const tracks = rawTracks.map(toSunoTrack);

  if (FAILED_STATUSES.has(rawStatus)) {
    return { status: "failed", tracks, errorMessage: data.errorMessage ?? rawStatus };
  }
  if (rawStatus === "SUCCESS") {
    return { status: "ready", tracks, errorMessage: null };
  }
  if (rawStatus === "FIRST_SUCCESS" || rawStatus === "TEXT_SUCCESS" || rawStatus === "PENDING") {
    return { status: tracks.length > 0 ? "partial" : "pending", tracks, errorMessage: null };
  }
  // Unknown status string: treat as still-pending rather than failing hard.
  return { status: tracks.length > 0 ? "partial" : "pending", tracks, errorMessage: null };
}

const BRIEF_INSTRUCTIONS =
  "You write a music brief for sunoapi.org's V5 custom-mode instrumental generator, scoring " +
  "background music for a video edit. Match the mood, energy and pacing of the user's brief " +
  "and the storyboard/scene descriptions. The result MUST be instrumental (no vocals, no lyrics) " +
  'and sit under dialogue and sound effects without competing for attention. Reply with STRICT ' +
  'JSON: {"style":"...","title":"...","prompt":"..."} — style is a short list of genre/instrumentation/mood ' +
  "descriptors, title is a short track name, prompt is a fuller description of the arrangement and feel.";

/**
 * One-shot LLM call (through the same OpenAI proxy the director uses) to
 * write a contextual music brief. Falls back to the pure heuristic in
 * @openreel/core on ANY failure — network, bad JSON, missing fields — so
 * music generation never blocks on this call. Always clamped to
 * MUSIC_LIMITS regardless of origin.
 */
export async function generateMusicBrief(
  userBrief: string,
  storyboard: Storyboard | null,
  targetS: number | null,
  sceneHints: string[],
): Promise<MusicBrief> {
  try {
    const lines = [
      `User's brief for the video: ${userBrief || "(none given)"}`,
      storyboard?.title ? `Storyboard title: ${storyboard.title}` : null,
      storyboard?.notes ? `Editor notes: ${storyboard.notes}` : null,
      storyboard && storyboard.items.length > 0
        ? `Shot roles in order: ${storyboard.items.map((i) => i.role).join(", ")}`
        : null,
      targetS != null ? `Target track length: ~${Math.round(targetS)} seconds` : null,
      sceneHints.length > 0 ? `Scene descriptions: ${sceneHints.join("; ")}` : null,
    ].filter((l): l is string => Boolean(l));

    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BRIEF_MODEL,
        messages: [
          { role: "system", content: BRIEF_INSTRUCTIONS },
          { role: "user", content: lines.join("\n") },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`music brief LLM ${res.status}`);

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { style?: unknown; title?: unknown; prompt?: unknown };
    if (
      typeof parsed.style !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.prompt !== "string" ||
      !parsed.style.trim() ||
      !parsed.title.trim() ||
      !parsed.prompt.trim()
    ) {
      throw new Error("music brief LLM: malformed JSON");
    }
    return clampMusicBrief({ style: parsed.style, title: parsed.title, prompt: parsed.prompt });
  } catch {
    return clampMusicBrief(buildMusicBriefFallback(userBrief, storyboard, targetS));
  }
}

/**
 * CDN URL mapping — verified 2026-07-05 to be a no-op: both track hosts
 * answer CORS-permissive (tempfile.aiquickdraw.com: ACAO *; and
 * musicfile.removeai.ai echoes the origin), which also satisfies this app's
 * COEP require-corp isolation when fetched/played with crossorigin
 * "anonymous". Kept as the ONE place to reroute through an nginx passthrough
 * if a future CDN host turns out closed.
 */
export function proxiedMusicUrl(url: string): string {
  return url;
}
