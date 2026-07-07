/**
 * The generate flow's top-level hook: owns the GenerateFlowState reducer
 * (state-machine.ts), the boot sequence (WebGPU gate → session → preset →
 * restore-offer check), the mock/real pipeline+director selection, the
 * bench's CutRequest, the file registry bridging PublicPipeline's opaque
 * clip ids to real Files (see services/file-handles.ts's StoredClip doc for
 * why), and every user action a scene can invoke. Exposed via React Context
 * (`useFlow()`) so the many scene components don't need 20-prop drilling.
 *
 * `?mock=1` (checked ONCE, here, and nowhere else) swaps in publicapp/
 * mocks.ts's scripted PublicPipeline/PublicDirector/session/preset in place
 * of WS-E's real hooks — never the default, per plan §G.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WIZZ_ERROR_CODES,
  WIZZ_PASSWORD_MIN_LENGTH,
  type LoginRequest,
  type QuotaCategory,
  type SignupRequest,
  type WizzErrorCode,
} from "@wizz/contracts";
import {
  usePublicPipeline,
  usePublicDirector,
  loadPublicRunConfig,
  type CutRequest,
  type PublicCut,
  type PublicDirector,
  type PublicPipeline,
  type PublicRunConfig,
} from "../publicflow";
import {
  GatewayError,
  getQuota,
  getSession,
  login,
  logout,
  sendTelemetry,
  signup,
} from "../services/gateway";
import {
  forgetClip,
  getStoredSessionInfo,
  handleFromDataTransferItem,
  pickFilesWithHandles,
  rememberClip,
  restoreSession,
} from "../services/file-handles";
import { mockGetSession, mockLogin, mockRunConfig, mockSignup, useMockDirector, useMockPipeline } from "./mocks";
import { nextUtcMidnightIso, restoreOfferLabel } from "./format";
import { openCutInEditor } from "./editor-handoff";
import { useAppRouter, type PublicRoute } from "./router";
import { useWizzTheme, type UseWizzThemeReturn } from "./theme";
import { applyEvent, INITIAL_FLOW_STATE, telemetryForTransition, type ApplyEventCtx } from "./state-machine";
import type { GenerateFlowEvent } from "@wizz/contracts";

const STUDIO_VISITED_KEY = "wizz:studio-visited";
const KNOWN_ERROR_CODES = new Set<string>(WIZZ_ERROR_CODES);

function hasVisitedStudioBefore(): boolean {
  try {
    return localStorage.getItem(STUDIO_VISITED_KEY) === "1";
  } catch {
    return false;
  }
}

function markStudioVisited(): void {
  try {
    localStorage.setItem(STUDIO_VISITED_KEY, "1");
  } catch {
    // private browsing / quota — the flag just won't survive this session.
  }
}

function asWizzErrorCode(code: string): WizzErrorCode {
  return KNOWN_ERROR_CODES.has(code) ? (code as WizzErrorCode) : "upstream_error";
}

async function checkWebGpuSupported(): Promise<boolean> {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/** Best-effort structured quota info for the quota-exceeded scene (see state-machine.ts's ApplyEventCtx doc). */
async function resolveQuotaCtx(isMock: boolean): Promise<{ category: QuotaCategory; resetsAt: string }> {
  if (isMock) return { category: "directorTokens", resetsAt: nextUtcMidnightIso() };
  try {
    const quota = await getQuota();
    const entries = Object.entries(quota.categories) as [
      QuotaCategory,
      { limit: number | null; used: number; remaining: number | null },
    ][];
    const exhausted = entries.find(([, v]) => v.remaining === 0);
    return { category: exhausted?.[0] ?? "directorTokens", resetsAt: quota.resetsAt };
  } catch {
    return { category: "directorTokens", resetsAt: nextUtcMidnightIso() };
  }
}

function authErrorMessage(err: unknown): string {
  if (err instanceof GatewayError) {
    switch (err.code) {
      case "invite_invalid":
        return "That invite code isn't valid — check it and try again.";
      case "email_taken":
        return "That email already has an account — sign in instead.";
      case "weak_password":
        return `Use at least ${WIZZ_PASSWORD_MIN_LENGTH} characters for your password.`;
      case "invalid_credentials":
        return "That email and password don't match.";
      case "account_disabled":
        return "This account has been disabled.";
      case "rate_limited":
        return "Too many attempts — wait a moment and try again.";
      default:
        return "Something went wrong on our end — try again in a moment.";
    }
  }
  return "Something went wrong on our end — try again in a moment.";
}

export interface RestoreProgress {
  restoring: boolean;
  /** Names of clips that failed to restore this attempt; null = nothing to show. */
  movedNames: string[] | null;
}

export interface FlowActions {
  signup(fields: { inviteCode: string; email: string; password: string }): Promise<void>;
  login(fields: { email: string; password: string }): Promise<void>;
  logout(): void;
  addFiles(files: File[]): void;
  addFilesFromDataTransfer(items: DataTransferItemList): Promise<void>;
  addFilesFromPicker(): Promise<void>;
  removeClip(id: string): void;
  retryClip(id: string): void;
  acceptRestore(): Promise<void>;
  declineRestore(): void;
  continueAfterMovedFiles(): void;
  generate(): void;
  refine(instruction: string): void;
  cancelDirecting(): void;
  changeSetup(): void;
  beginRender(): void;
  finishRender(): void;
  cancelRender(): void;
  openEditor(): Promise<{ ok: boolean; error?: string }>;
  retry(): void;
}

export interface Flow {
  booted: boolean;
  isMock: boolean;
  route: PublicRoute;
  navigate: (route: PublicRoute) => void;
  state: ReturnType<typeof applyEvent>;
  email: string | null;
  config: PublicRunConfig | null;
  pipeline: PublicPipeline;
  director: PublicDirector;
  currentCut: PublicCut | null;
  /** Increments only on a genuinely new cut (DIRECTOR_DONE), never on a later in-place music-ready update to the same cut — see use-generate-flow.ts's cutSeq comment. */
  cutSeq: number;
  cutRequest: CutRequest;
  setCutRequest: (patch: Partial<CutRequest>) => void;
  selectedTake: "a" | "b";
  setSelectedTake: (take: "a" | "b") => void;
  restoreProgress: RestoreProgress;
  authBusy: boolean;
  authError: string | null;
  directorRetryNote: string | null;
  theme: UseWizzThemeReturn;
  getFileForClip: (clipId: string) => File | null;
  track: (type: Parameters<typeof sendTelemetry>[0], data?: Parameters<typeof sendTelemetry>[1]) => void;
  actions: FlowActions;
}

/**
 * The flow hook itself — JSX-free so this file can stay a plain .ts module.
 * flow-context.tsx wraps this in a Context/Provider (`useFlow()`) for the
 * scene components to consume without prop-drilling.
 */
export function useGenerateFlow(): Flow {
  const isMock = useMemo(() => new URLSearchParams(window.location.search).get("mock") === "1", []);
  const mockFail = useMemo(() => new URLSearchParams(window.location.search).get("mockfail"), []);
  const { route, navigate } = useAppRouter();
  const theme = useWizzTheme();

  const [booted, setBooted] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicRunConfig | null>(null);
  const [state, setState] = useState(INITIAL_FLOW_STATE);
  const stateRef = useRef(state);

  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [directorRetryNote, setDirectorRetryNote] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMoved, setRestoreMoved] = useState<string[] | null>(null);
  const pendingRestoredFilesRef = useRef<File[]>([]);

  const [cutRequest, setCutRequestState] = useState<CutRequest>({
    styleId: null,
    brief: "",
    targetS: 60,
    music: true,
  });
  const [selectedTake, setSelectedTake] = useState<"a" | "b">("a");

  const fileRegistryRef = useRef<Map<string, File>>(new Map());

  const track = useCallback<Flow["track"]>((type, data) => sendTelemetry(type, data), []);

  const dispatchFlow = useCallback(
    (event: GenerateFlowEvent, ctx?: ApplyEventCtx) => {
      const prev = stateRef.current;
      let next = applyEvent(prev, event, ctx);
      if (next.name === "studio-empty" && event.type === "SESSION_OK") {
        const firstVisit = !hasVisitedStudioBefore();
        markStudioVisited();
        next = { ...next, firstVisit };
      }
      stateRef.current = next;
      setState(next);
      for (const t of telemetryForTransition(prev, event)) track(t.type, t.data);
    },
    [track],
  );

  // ── pipeline + director: both hooks always run (rules of hooks); the
  // mock/real choice only picks which resulting OBJECT the rest of the flow
  // consumes, so there's no conditional-hook risk. ──────────────────────
  const realPipeline = usePublicPipeline(config);
  const mockPipeline = useMockPipeline(config);
  const pipeline = isMock ? mockPipeline : realPipeline;

  // usePublicDirector's second arg is the PublicPipelineHandle (getDossiers +
  // embedQuery for its search_shots tool) — always the REAL pipeline handle
  // here, never the mock/real ternary: realDirector is only ever consumed
  // when !isMock, at which point `pipeline` IS realPipeline anyway, but
  // realPipeline is the one object that's actually typed as a
  // PublicPipelineHandle (mockPipeline is a plain PublicPipeline).
  const realDirector = usePublicDirector(config, realPipeline);
  const mockDirector = useMockDirector(pipeline);
  const director = isMock ? mockDirector : realDirector;

  const currentCut = director.phase.kind === "done" ? director.phase.cut : null;

  // A "new cut arrived" signal that is NOT just currentCut's object identity:
  // WS-E's director reducer (use-public-director.ts's music-ready action)
  // rebuilds a new `{...phase.cut, musicTakes}` object in place once Suno's
  // ~60s generation lands — same cut, new reference. Keying the screening
  // room's reset effects on `currentCut` directly would jerk the player back
  // to segment 0 and reset the A/B pick the moment music shows up mid-watch.
  // cutSeq increments only on the DIRECTOR_DONE transition below (a
  // genuinely new generate/refine), never on a later music-ready update to
  // the SAME cut.
  const [cutSeq, setCutSeq] = useState(0);

  useEffect(() => {
    setSelectedTake("a"); // a genuinely NEW cut → fresh A/B choice
  }, [cutSeq]);

  // ── director phase → flow transitions ───────────────────────────────
  const handledPhaseRef = useRef(director.phase);
  useEffect(() => {
    if (director.phase === handledPhaseRef.current) return;
    handledPhaseRef.current = director.phase;
    if (stateRef.current.name !== "directing") return;
    if (director.phase.kind === "done") {
      dispatchFlow({ type: "DIRECTOR_DONE" });
      setCutSeq((n) => n + 1);
    } else if (director.phase.kind === "error") {
      const code = asWizzErrorCode(director.phase.code);
      if (code === "rate_limited") {
        setDirectorRetryNote(director.phase.friendly);
        dispatchFlow({ type: "DIRECTOR_FAILED", code });
      } else if (code === "quota_exceeded") {
        void resolveQuotaCtx(isMock).then((quota) => dispatchFlow({ type: "DIRECTOR_FAILED", code }, { quota }));
      } else {
        dispatchFlow({ type: "DIRECTOR_FAILED", code });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [director.phase]);

  // ── analyze_started/completed edge-triggers off the live pipeline
  // (see state-machine.ts's file header on why allReady can't be owned by
  // the pure reducer alone). ───────────────────────────────────────────
  const prevAllReadyRef = useRef(false);
  useEffect(() => {
    if (stateRef.current.name !== "bench") {
      prevAllReadyRef.current = pipeline.allReady;
      return;
    }
    if (pipeline.allReady && !prevAllReadyRef.current) {
      dispatchFlow({ type: "ALL_CLIPS_READY" });
    }
    prevAllReadyRef.current = pipeline.allReady;
  }, [pipeline.allReady, dispatchFlow]);

  // ── boot: WebGPU gate → session → preset → restore offer ─────────────
  // Route sync (contracts §"build targets": "needs-auth state routes to
  // /app/auth"): completeSessionBoot is the one place a needs-auth → real
  // session transition happens (both at boot and after login/signup), so
  // it's also the one place that needs to correct the URL — targeted calls
  // here instead of a generic state.name-watching effect, which would risk
  // firing before the boot sequence has even resolved the real state (the
  // reducer's INITIAL_FLOW_STATE is needs-auth as a safe default, not a
  // verdict) and stomping a deep-linked route before boot has a chance to
  // confirm it.
  const completeSessionBoot = useCallback(
    async (userEmail: string) => {
      setEmail(userEmail);
      dispatchFlow({ type: "SESSION_OK" });
      if (route === "auth") navigate("generate", { replace: true });
      const loadedConfig = isMock ? mockRunConfig() : await loadPublicRunConfig().catch(() => null);
      setConfig(loadedConfig);
      const info = await getStoredSessionInfo().catch(() => null);
      if (info) {
        dispatchFlow({
          type: "RESTORE_AVAILABLE",
          clipCount: info.clipCount,
          label: restoreOfferLabel(info.savedAt),
        });
      }
    },
    [isMock, dispatchFlow, route, navigate],
  );

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (isMock && mockFail === "unsupported_browser") {
        dispatchFlow({ type: "UNSUPPORTED_BROWSER" });
        setBooted(true);
        return;
      }
      const gpuOk = await checkWebGpuSupported();
      if (cancelled) return;
      if (!gpuOk) {
        dispatchFlow({ type: "UNSUPPORTED_BROWSER" });
        setBooted(true);
        return;
      }
      try {
        const session = isMock ? await mockGetSession() : await getSession();
        if (cancelled) return;
        await completeSessionBoot(session.user.email);
      } catch {
        if (cancelled) return;
        dispatchFlow({ type: "SESSION_MISSING" });
        // A deep link straight to /app/generate (or bare /app) with no
        // session lands on the auth form; /app/editor is left alone (its
        // route is independent of the auth-gated generate flow's own
        // routing — it renders against whatever's already in the project
        // store, one-way-door style). `route` here is the route read at
        // mount (this effect intentionally runs once), which is exactly
        // the deep-linked route this check needs.
        if (route !== "auth" && route !== "editor") {
          navigate("auth", { replace: true });
        }
      } finally {
        if (!cancelled) setBooted(true);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
    // Runs exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── bench defaults from the loaded preset (one-time, when config arrives) ──
  useEffect(() => {
    if (!config) return;
    setCutRequestState((prev) => ({
      ...prev,
      targetS: config.durationChips[1] ?? config.durationChips[0] ?? prev.targetS,
      music: config.musicEnabled,
    }));
  }, [config]);

  const setCutRequest = useCallback((patch: Partial<CutRequest>) => {
    setCutRequestState((prev) => ({ ...prev, ...patch }));
  }, []);

  /* ─────────────────────────────── auth ─────────────────────────────── */

  const signupAction = useCallback(
    async (fields: { inviteCode: string; email: string; password: string }) => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        const req: SignupRequest = {
          inviteCode: fields.inviteCode.trim(),
          email: fields.email.trim(),
          password: fields.password,
        };
        const session = isMock ? await mockSignup(req) : await signup(req);
        await completeSessionBoot(session.user.email);
      } catch (err) {
        setAuthError(authErrorMessage(err));
      } finally {
        setAuthBusy(false);
      }
    },
    [isMock, completeSessionBoot],
  );

  const loginAction = useCallback(
    async (fields: { email: string; password: string }) => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        const req: LoginRequest = { email: fields.email.trim(), password: fields.password };
        const session = isMock ? await mockLogin(req) : await login(req);
        await completeSessionBoot(session.user.email);
      } catch (err) {
        setAuthError(authErrorMessage(err));
      } finally {
        setAuthBusy(false);
      }
    },
    [isMock, completeSessionBoot],
  );

  const logoutAction = useCallback(() => {
    if (!isMock) void logout().catch(() => {});
    setEmail(null);
    setAuthError(null);
    dispatchFlow({ type: "SESSION_MISSING" });
    navigate("auth", { replace: true });
  }, [isMock, dispatchFlow, navigate]);

  /* ────────────────────────────── footage ───────────────────────────── */

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      for (const f of files) fileRegistryRef.current.set(f.name, f);
      pipeline.addFiles(files);
      dispatchFlow({ type: "CLIPS_ADDED" });
    },
    [pipeline, dispatchFlow],
  );

  const addFilesFromDataTransfer = useCallback(
    async (items: DataTransferItemList) => {
      const files: File[] = [];
      const handleTasks: Promise<void>[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (!file) continue;
        if (!file.type.startsWith("video/") && !file.name.toLowerCase().endsWith(".lrf")) continue;
        files.push(file);
        handleTasks.push(
          handleFromDataTransferItem(item).then((handle) => {
            if (!handle) return;
            void rememberClip({ id: file.name, name: file.name, size: file.size, handle }).catch((err) =>
              console.error("[wizz] failed to remember file handle", err),
            );
          }),
        );
      }
      addFiles(files);
      await Promise.allSettled(handleTasks);
    },
    [addFiles],
  );

  const addFilesFromPicker = useCallback(async () => {
    const picked = await pickFilesWithHandles();
    if (picked.length === 0) return;
    addFiles(picked.map((p) => p.file));
    for (const { file, handle } of picked) {
      void rememberClip({ id: file.name, name: file.name, size: file.size, handle }).catch((err) =>
        console.error("[wizz] failed to remember file handle", err),
      );
    }
  }, [addFiles]);

  const removeClip = useCallback(
    (id: string) => {
      const clip = pipeline.clips.find((c) => c.id === id);
      pipeline.removeClip(id);
      if (clip) void forgetClip(clip.name).catch(() => {});
    },
    [pipeline],
  );

  const retryClip = useCallback((id: string) => pipeline.retryClip(id), [pipeline]);

  /* ────────────────────────────── restore ───────────────────────────── */

  const proceedWithRestoredFiles = useCallback(() => {
    const files = pendingRestoredFilesRef.current;
    pendingRestoredFilesRef.current = [];
    setRestoreMoved(null);
    dispatchFlow({ type: "RESTORE_ACCEPTED" });
    if (files.length > 0) {
      for (const f of files) fileRegistryRef.current.set(f.name, f);
      pipeline.addFiles(files);
    }
  }, [pipeline, dispatchFlow]);

  const acceptRestore = useCallback(async () => {
    if (stateRef.current.name !== "studio-restore-offer") return;
    setRestoring(true);
    setRestoreMoved(null);
    try {
      const result = await restoreSession();
      pendingRestoredFilesRef.current = result.restored.map((r) => r.file);
      if (result.moved.length > 0) {
        setRestoreMoved(result.moved.map((m) => m.name));
      } else {
        proceedWithRestoredFiles();
      }
    } catch (err) {
      console.error("[wizz] restore failed", err);
      setRestoreMoved([]);
    } finally {
      setRestoring(false);
    }
  }, [proceedWithRestoredFiles]);

  const declineRestore = useCallback(() => {
    setRestoring(false);
    setRestoreMoved(null);
    dispatchFlow({ type: "RESTORE_DECLINED" });
  }, [dispatchFlow]);

  /* ─────────────────────────── directing / screening ────────────────── */

  const generate = useCallback(() => {
    if (!pipeline.allReady) return;
    setDirectorRetryNote(null);
    dispatchFlow({ type: "GENERATE" });
    director.generate(cutRequest);
  }, [pipeline.allReady, cutRequest, director, dispatchFlow]);

  const refine = useCallback(
    (instruction: string) => {
      setDirectorRetryNote(null);
      dispatchFlow({ type: "REFINE" });
      director.refine(instruction);
    },
    [director, dispatchFlow],
  );

  const cancelDirecting = useCallback(() => {
    director.cancel();
    dispatchFlow({ type: "DIRECTOR_CANCELLED" });
  }, [director, dispatchFlow]);

  const changeSetup = useCallback(() => {
    director.reset();
    dispatchFlow({ type: "CHANGE_SETUP" });
  }, [director, dispatchFlow]);

  const beginRender = useCallback(() => dispatchFlow({ type: "RENDER" }), [dispatchFlow]);
  const finishRender = useCallback(() => dispatchFlow({ type: "RENDER_DONE" }), [dispatchFlow]);
  const cancelRender = useCallback(() => dispatchFlow({ type: "RENDER_CANCELLED" }), [dispatchFlow]);

  const retry = useCallback(() => dispatchFlow({ type: "RETRY" }), [dispatchFlow]);

  const getFileForClip = useCallback(
    (clipId: string): File | null => {
      const clip = pipeline.clips.find((c) => c.id === clipId);
      if (!clip) return null;
      return fileRegistryRef.current.get(clip.name) ?? null;
    },
    [pipeline.clips],
  );

  const openEditor = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!currentCut) return { ok: false, error: "no cut to open" };
    track("editor_opened");
    const musicUrl = currentCut.musicTakes
      ? selectedTake === "a"
        ? currentCut.musicTakes.a
        : currentCut.musicTakes.b
      : null;
    const result = await openCutInEditor({
      cut: currentCut,
      getFile: getFileForClip,
      fileNameOf: (clipId) => pipeline.clips.find((c) => c.id === clipId)?.name ?? clipId,
      music: musicUrl ? { audioUrl: musicUrl, durationS: currentCut.totalS } : null,
    });
    if (!result.ok) {
      console.error("[wizz] editor handoff failed", result.error, result.missing);
      return { ok: false, error: result.error ?? "some source files are unavailable" };
    }
    navigate("editor");
    return { ok: true };
  }, [currentCut, selectedTake, getFileForClip, pipeline.clips, navigate, track]);

  return {
    booted,
    isMock,
    route,
    navigate,
    state,
    email,
    config,
    pipeline,
    director,
    currentCut,
    cutSeq,
    cutRequest,
    setCutRequest,
    selectedTake,
    setSelectedTake,
    restoreProgress: { restoring, movedNames: restoreMoved },
    authBusy,
    authError,
    directorRetryNote,
    theme,
    getFileForClip,
    track,
    actions: {
      signup: signupAction,
      login: loginAction,
      logout: logoutAction,
      addFiles,
      addFilesFromDataTransfer,
      addFilesFromPicker,
      removeClip,
      retryClip,
      acceptRestore,
      declineRestore,
      continueAfterMovedFiles: proceedWithRestoredFiles,
      generate,
      refine,
      cancelDirecting,
      changeSetup,
      beginRender,
      finishRender,
      cancelRender,
      openEditor,
      retry,
    },
  };
}
