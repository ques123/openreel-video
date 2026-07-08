/**
 * Scripted PublicPipeline/PublicDirector implementations reproducing the
 * approved wireframe's simulation (docs/wizz-ui-draft.html's CLIPS/STAGES/
 * STREAM_LINES/SEGS + prepSim/startAnalysis/startDirecting/startRender) —
 * so every scene is browsable end to end before WS-E's real hooks land, and
 * so the flow stays testable afterwards without the 1.5GB local models.
 *
 * Activation is the CALLER's job (use-generate-flow.ts checks `?mock=1`) —
 * this module makes no attempt to detect mock mode itself, so it can never
 * accidentally activate outside that one explicit gate.
 *
 * Real per-clip thumbnails/durations ARE decoded (hidden <video> + canvas
 * snapshot) even here — cheap, no ML/GPU, and it makes the bench/screening
 * room look right instead of gray placeholder boxes through every dev
 * session. Music takes are synthesized as short audible tones (no network
 * asset, no dependency) so the screening room's A/B actually differs. They
 * land ~3s after the cut itself (musicPending true meanwhile), not
 * synchronously — the same timersRef pattern as the narrative stream — so
 * ?mock=1 exercises the screening room's composing indicator too, not just
 * the finished A/B state.
 *
 * Failure-path testing: appending `&mockfail=quota_exceeded` (or
 * `kill_switch` | `upstream_error` | `rate_limited` | `auth_required`) to the
 * URL makes the NEXT generate/refine run end in that DirectorPhase error
 * instead of a finished cut, so the away/quota-exceeded/needs-auth scenes
 * are reachable without a real gateway.
 */
import { useEffect, useRef, useState } from "react";
import { STYLE_PRESETS } from "@openreel/core";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PUBLISHED_PRESET,
  type LoginRequest,
  type SessionResponse,
  type SignupRequest,
} from "@wizz/contracts";
import { GatewayError } from "../services/gateway";
import type {
  CutRequest,
  DirectorPhase,
  PublicClip,
  PublicClipStatus,
  PublicCut,
  PublicDirector,
  PublicPipeline,
  PublicRunConfig,
} from "../publicflow/types";

/**
 * Mock session/preset — used only behind `?mock=1`. `mockGetSession` always
 * rejects (no session yet) so the needs-auth scene + mockSignup/mockLogin's
 * error paths below are exercised on every mock session, same as a real
 * first-ever visit; `mockRunConfig` resolves the style whitelist against the
 * real @openreel/core STYLE_PRESETS (the placeholder loadPublicRunConfig in
 * publicflow/preset-runtime.ts doesn't do this yet — WS-E's real
 * implementation doc comment says it should) so the bench's style cards show
 * real labels/taglines instead of raw ids with blank subtitles.
 */
export async function mockGetSession(): Promise<SessionResponse> {
  throw new GatewayError({ code: "auth_required", status: 401, message: "no session (mock)" });
}

export function mockRunConfig(): PublicRunConfig {
  const preset = DEFAULT_PUBLISHED_PRESET;
  const styles = preset.styleWhitelist
    .map((id) => STYLE_PRESETS.find((s) => s.id === id))
    .filter((s): s is (typeof STYLE_PRESETS)[number] => Boolean(s))
    .map((s) => ({ id: s.id, label: s.label, tagline: s.tagline }));
  return {
    preset,
    labSettings: null,
    styles,
    durationChips: preset.targetDurationChoicesS,
    allowCustomDuration: preset.allowCustomDuration,
    minTargetS: preset.minTargetDurationS,
    maxTargetS: preset.maxTargetDurationS,
    musicEnabled: preset.musicEnabled,
    cloudSTTDefaultOn: preset.cloudSTTDefaultOn,
    cap: DEFAULT_GLOBAL_SETTINGS.footageCap,
  };
}

/* ────────────────────────────────── auth ────────────────────────────────── */

/**
 * The wireframe's invite card is pre-filled with "WZ-4F7K-2026" — the mock
 * treats that as the one valid code so the happy path needs no thought, while
 * still exercising every GatewayError code the real AuthScene must map to
 * friendly copy (contracts §"Auth"): invite_invalid, email_taken,
 * weak_password, invalid_credentials.
 */
const MOCK_VALID_INVITE = "WZ-4F7K-2026";
const MOCK_TAKEN_EMAIL = "taken@example.com";
const MOCK_WRONG_PASSWORD = "wrong";

function mockUser(email: string): SessionResponse {
  return { user: { id: "mock-user", email, createdAt: new Date(0).toISOString() } };
}

/** Stands in for services/gateway.ts's signup() when `?mock=1` — same thrown shape. */
export async function mockSignup(req: SignupRequest): Promise<SessionResponse> {
  if (req.inviteCode.trim().toUpperCase() !== MOCK_VALID_INVITE) {
    throw new GatewayError({ code: "invite_invalid", status: 400, message: "invite invalid (mock)" });
  }
  if (req.email.trim().toLowerCase() === MOCK_TAKEN_EMAIL) {
    throw new GatewayError({ code: "email_taken", status: 400, message: "email taken (mock)" });
  }
  if (req.password.length < 8) {
    throw new GatewayError({ code: "weak_password", status: 400, message: "weak password (mock)" });
  }
  return mockUser(req.email.trim().toLowerCase());
}

/** Stands in for services/gateway.ts's login() when `?mock=1` — same thrown shape. */
export async function mockLogin(req: LoginRequest): Promise<SessionResponse> {
  if (req.password === MOCK_WRONG_PASSWORD) {
    throw new GatewayError({ code: "invalid_credentials", status: 401, message: "invalid credentials (mock)" });
  }
  return mockUser(req.email.trim().toLowerCase());
}

const STAGE_LABELS = ["watching your footage", "listening for speech", "describing what it sees"];
const ANALYSIS_TICK_MS = 130;
const STAGE_STEP = 0.22;
const STUDIO_WARM_KEY = "wizz:mock-studio-warm";
/** Demo-speed stand-in for Suno's real ~60s generation — long enough to see the composing indicator, short enough not to make ?mock=1 tedious. */
const MOCK_MUSIC_DELAY_MS = 3000;

function uid(): string {
  return `mock-${Math.random().toString(36).slice(2, 10)}`;
}

function mockFailCode(): string | null {
  return new URLSearchParams(window.location.search).get("mockfail");
}

/* ─────────────────────────── cheap real decode ─────────────────────────── */

interface Probe {
  durationS: number | null;
  thumbnailUrl: string | null;
}

/** Hidden <video> + canvas snapshot — real duration/thumbnail, no ML involved. */
async function quickProbe(file: File): Promise<Probe> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    let settled = false;
    const finish = (result: Probe) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timeout = window.setTimeout(() => finish({ durationS: null, thumbnailUrl: null }), 4000);
    video.onerror = () => finish({ durationS: null, thumbnailUrl: null });
    video.onloadedmetadata = () => {
      const d = video.duration;
      video.currentTime = Math.min(Number.isFinite(d) ? d / 2 : 1, 1);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish({
          durationS: Number.isFinite(video.duration) ? video.duration : null,
          thumbnailUrl: ctx ? canvas.toDataURL("image/jpeg", 0.7) : null,
        });
      } catch {
        finish({ durationS: Number.isFinite(video.duration) ? video.duration : null, thumbnailUrl: null });
      }
    };
    video.src = url;
  });
}

/* ─────────────────────────────── pipeline ─────────────────────────────── */

interface MockClipInternal {
  id: string;
  name: string;
  durationS: number | null;
  thumbnailUrl: string | null;
  status: PublicClipStatus;
}

function toPublicClip(c: MockClipInternal): PublicClip {
  return { id: c.id, name: c.name, durationS: c.durationS, thumbnailUrl: c.thumbnailUrl, status: c.status };
}

function initialModelPrep(): { progress: number; done: boolean } | null {
  try {
    return localStorage.getItem(STUDIO_WARM_KEY) ? null : { progress: 0, done: false };
  } catch {
    return { progress: 0, done: false };
  }
}

/** One tick of the shared queue driver: promote the next queued clip, or advance the busy one. */
function advanceQueue(
  prev: MockClipInternal[],
  flakyId: string | null,
  flakyFailedOnceRef: { current: boolean },
): MockClipInternal[] {
  const busyIndex = prev.findIndex((c) => c.status.kind === "analyzing");
  if (busyIndex === -1) {
    const queuedIndex = prev.findIndex((c) => c.status.kind === "queued");
    if (queuedIndex === -1) return prev;
    const next = [...prev];
    next[queuedIndex] = {
      ...next[queuedIndex],
      status: { kind: "analyzing", stageLabel: STAGE_LABELS[0], progress: 0.05 },
    };
    return next;
  }
  const busy = prev[busyIndex];
  if (busy.status.kind !== "analyzing") return prev;
  const stageIdx = STAGE_LABELS.indexOf(busy.status.stageLabel);
  const bumped = busy.status.progress + STAGE_STEP;
  const next = [...prev];
  if (bumped < 1) {
    next[busyIndex] = { ...busy, status: { kind: "analyzing", stageLabel: busy.status.stageLabel, progress: bumped } };
    return next;
  }
  const nextStageIdx = stageIdx + 1;
  if (nextStageIdx < STAGE_LABELS.length) {
    next[busyIndex] = {
      ...busy,
      status: { kind: "analyzing", stageLabel: STAGE_LABELS[nextStageIdx], progress: 0.05 },
    };
    return next;
  }
  const isFlaky = flakyId !== null && busy.id === flakyId;
  if (isFlaky && !flakyFailedOnceRef.current) {
    flakyFailedOnceRef.current = true;
    next[busyIndex] = {
      ...busy,
      status: {
        kind: "error",
        message: "Couldn't read this file — it may be corrupted or use an unsupported codec.",
        retryable: true,
      },
    };
  } else {
    next[busyIndex] = { ...busy, status: { kind: "ready" } };
  }
  return next;
}

/**
 * Mock PublicPipeline: real decode, scripted stage progression. Exactly one
 * clip fails once per session (the first ever dropped) purely to exercise
 * the error-row + retry affordance, then succeeds on retry.
 */
export function useMockPipeline(config: PublicRunConfig | null): PublicPipeline {
  const [clips, setClips] = useState<MockClipInternal[]>([]);
  const [cloudSTT, setCloudSTT] = useState(config?.cloudSTTDefaultOn ?? true);
  const [lastRefusal, setLastRefusal] = useState<PublicPipeline["lastRefusal"]>(null);
  const [modelPrep, setModelPrep] = useState<{ progress: number; done: boolean } | null>(initialModelPrep);
  const flakyIdRef = useRef<string | null>(null);
  const hasPickedFlakyRef = useRef(false);
  const flakyFailedOnceRef = useRef(false);
  const cap = config?.cap ?? { maxClips: 25, maxTotalSeconds: 3600 };

  useEffect(() => {
    if (!modelPrep || modelPrep.done) return;
    const iv = window.setInterval(() => {
      setModelPrep((prev) => {
        if (!prev || prev.done) return prev;
        const next = Math.min(100, prev.progress + 9);
        if (next >= 100) {
          try {
            localStorage.setItem(STUDIO_WARM_KEY, "1");
          } catch {
            // private browsing / quota — the studio still warms for this tab.
          }
          return { progress: 100, done: true };
        }
        return { progress: next, done: false };
      });
    }, 320);
    return () => window.clearInterval(iv);
    // Intentionally NOT depending on the whole `modelPrep` object — only
    // `.done` should (re)arm/clear this interval; the interval's own
    // functional setModelPrep update handles the per-tick progress bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPrep?.done]);

  useEffect(() => {
    const anyPending = clips.some((c) => c.status.kind === "queued" || c.status.kind === "analyzing");
    if (!anyPending) return;
    const iv = window.setInterval(() => {
      setClips((prev) => advanceQueue(prev, flakyIdRef.current, flakyFailedOnceRef));
    }, ANALYSIS_TICK_MS);
    return () => window.clearInterval(iv);
    // advanceQueue mutates flakyFailedOnceRef.current in place (the ref
    // object itself is passed, not its value), so it isn't a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    const room = Math.max(0, cap.maxClips - clips.length);
    const accepted = files.slice(0, room);
    const refused = files.length - accepted.length;
    setLastRefusal(refused > 0 ? { reason: "maxClips", count: refused } : null);
    if (accepted.length === 0) return;
    const additions: MockClipInternal[] = accepted.map((f) => {
      const id = uid();
      if (!hasPickedFlakyRef.current) {
        hasPickedFlakyRef.current = true;
        flakyIdRef.current = id;
      }
      void quickProbe(f).then((probe) => {
        setClips((cur) => cur.map((c) => (c.id === id ? { ...c, ...probe } : c)));
      });
      return { id, name: f.name, durationS: null, thumbnailUrl: null, status: { kind: "queued" } };
    });
    setClips((prev) => [...prev, ...additions]);
  };

  const removeClip = (id: string): void => setClips((prev) => prev.filter((c) => c.id !== id));
  const retryClip = (id: string): void =>
    setClips((prev) =>
      prev.map((c) => (c.id === id && c.status.kind === "error" ? { ...c, status: { kind: "queued" } } : c)),
    );

  const total = clips.length;
  const doneCount = clips.filter((c) => c.status.kind === "ready" || c.status.kind === "error").length;
  const remaining = total - doneCount;
  const busyIdx = clips.findIndex((c) => c.status.kind === "analyzing");
  const currentIndex = busyIdx !== -1 ? busyIdx : Math.min(doneCount, Math.max(0, total - 1));
  const allReady = total > 0 && clips.every((c) => c.status.kind === "ready");

  return {
    clips: clips.map(toPublicClip),
    addFiles,
    removeClip,
    retryClip,
    allReady,
    batch: remaining > 0 ? { currentIndex, total, etaS: remaining * 45 } : null,
    cloudSTT,
    setCloudSTT,
    modelPrep,
    cap,
    lastRefusal,
  };
}

/* ─────────────────────────────── director ─────────────────────────────── */

const STREAM_TEMPLATE: { text: string; isQuery: boolean }[] = [
  { text: "Reading the footage notes…", isQuery: false },
  { text: "people laughing around a table at dusk", isQuery: true },
  { text: "wide shot of the ferry crossing, golden light", isQuery: true },
  { text: "Assembling a cut…", isQuery: false },
  { text: "Reviewing it against your brief…", isQuery: false },
  { text: "Tightening two rough cuts…", isQuery: false },
  { text: "Composing the music brief…", isQuery: false },
];

const MOCK_WHYS = [
  "Opens wide — sets the place and the light.",
  "First faces: this pays off the calm open.",
  "Handheld energy keeps the middle moving.",
  "A quiet beat, held long enough to breathe.",
  "Texture and sound carry this one.",
  "Re-establishes scale before the turn.",
  "The brief asked to feature this — the peak.",
  "Slower cut rhythm winds it down.",
  "Ends abruptly — leaves it open, not closed.",
];

const FAIL_COPY: Record<string, { friendly: string; retryable: boolean }> = {
  quota_exceeded: { friendly: "Today's directing budget is spent.", retryable: false },
  kill_switch: { friendly: "The director is taking a break.", retryable: true },
  upstream_error: { friendly: "The director's connection dropped mid-round.", retryable: true },
  rate_limited: { friendly: "A few too many requests in a row — give it a moment.", retryable: true },
  auth_required: { friendly: "Your session expired.", retryable: false },
};

/** A short, audible sine-tone WAV — no network asset, so A vs B genuinely differ. */
function synthesizeToneUrl(freqHz: number, seconds: number): string {
  const sampleRate = 8000;
  const numSamples = Math.floor(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const fade = Math.min(1, t * 8, (seconds - t) * 8);
    const sample = Math.sin(2 * Math.PI * freqHz * t) * 0.2 * Math.max(0, fade);
    view.setInt16(44 + i * 2, sample * 32767, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * Mock PublicDirector: replays the wireframe's narrative stream, then either
 * hands back a fabricated PublicCut built from the pipeline's ready clips, or
 * (when `?mockfail=<code>` is set) ends in the matching DirectorPhase error —
 * see use-generate-flow.ts for how each code maps to a flow scene.
 */
export function useMockDirector(pipeline: PublicPipeline): PublicDirector {
  const [phase, setPhase] = useState<DirectorPhase>({ kind: "idle" });
  const timersRef = useRef<number[]>([]);
  const musicUrlsRef = useRef<{ a: string; b: string } | null>(null);
  const lastRequestRef = useRef<CutRequest>({ styleId: null, brief: "", targetS: 60, music: false });

  useEffect(
    () => () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      if (musicUrlsRef.current) {
        URL.revokeObjectURL(musicUrlsRef.current.a);
        URL.revokeObjectURL(musicUrlsRef.current.b);
      }
    },
    [],
  );

  const clearTimers = (): void => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };

  const ensureMusicUrls = (): { a: string; b: string } => {
    if (!musicUrlsRef.current) {
      musicUrlsRef.current = { a: synthesizeToneUrl(220, 6), b: synthesizeToneUrl(330, 6) };
    }
    return musicUrlsRef.current;
  };

  const buildCut = (request: CutRequest, refined: boolean): PublicCut => {
    const readyClips = pipeline.clips.filter((c) => c.status.kind === "ready");
    const segCount = Math.max(1, Math.min(readyClips.length || 1, 9));
    const perSegS = Math.max(1, request.targetS / segCount);
    const segments = Array.from({ length: segCount }, (_, i) => {
      const clip = readyClips[i % Math.max(1, readyClips.length)];
      return {
        clipId: clip?.id ?? "unknown",
        inS: 0,
        outS: perSegS,
        why: MOCK_WHYS[i % MOCK_WHYS.length],
        thumbnailUrl: clip?.thumbnailUrl ?? null,
      };
    });
    return {
      title: refined ? "Golden Hour, Quieter" : "Golden Hour, Mostly",
      totalS: segments.reduce((sum, s) => sum + (s.outS - s.inS), 0),
      segments,
      clipCount: readyClips.length,
      // Takes land later (see runDirecting's musicT) — never synchronously —
      // so the screening room's composing indicator has a window to show.
      musicTakes: null,
      musicPending: request.music,
    };
  };

  const runDirecting = (request: CutRequest, refined: boolean): void => {
    clearTimers();
    setPhase({ kind: "running", activity: [] });
    STREAM_TEMPLATE.forEach((line, i) => {
      const t = window.setTimeout(() => {
        setPhase((prev) =>
          prev.kind === "running" ? { kind: "running", activity: [...prev.activity, line] } : prev,
        );
      }, 500 + i * 550);
      timersRef.current.push(t);
    });
    const finishT = window.setTimeout(
      () => {
        const failCode = mockFailCode();
        if (failCode && failCode in FAIL_COPY) {
          setPhase({ kind: "error", code: failCode, ...FAIL_COPY[failCode] });
          return;
        }
        const cut = buildCut(request, refined);
        setPhase({ kind: "done", cut });
        if (cut.musicPending) {
          const musicT = window.setTimeout(() => {
            setPhase((prev) =>
              prev.kind === "done"
                ? { kind: "done", cut: { ...prev.cut, musicTakes: ensureMusicUrls(), musicPending: false } }
                : prev,
            );
          }, MOCK_MUSIC_DELAY_MS);
          timersRef.current.push(musicT);
        }
      },
      500 + STREAM_TEMPLATE.length * 550 + 700,
    );
    timersRef.current.push(finishT);
  };

  return {
    phase,
    generate: (request) => {
      lastRequestRef.current = request;
      runDirecting(request, false);
    },
    refine: (_instruction) => {
      // The mock doesn't condition on instruction text — it re-runs the same
      // scripted stream against the last request and flags the resulting
      // title, matching the wireframe's reCut() behavior.
      runDirecting(lastRequestRef.current, true);
    },
    cancel: () => {
      clearTimers();
      setPhase((prev) => (prev.kind === "running" ? { kind: "idle" } : prev));
    },
    reset: () => {
      clearTimers();
      setPhase({ kind: "idle" });
    },
  };
}
