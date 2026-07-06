/**
 * Contextual background-music lifecycle: once the director lands a
 * storyboard and the "music" toggle is on, this hook drafts a brief, kicks
 * off Suno generation, and polls until tracks land. sunoapi.org typically
 * returns TWO variations from one task — they're surfaced as soon as the
 * task reports "partial" so the A/B UI can start playing before the second
 * take finishes, then settle at "ready" (or "failed").
 *
 * Poll loop is a setTimeout chain (not setInterval) held in a ref so a slow
 * request can't overlap the next tick; a cancelled ref stops stray writes
 * after unmount/reset, and a running ref guards against a duplicate
 * generate() call firing a second task for the same request.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicBrief, Storyboard } from "@openreel/core";
import {
  generateMusicBrief,
  pollMusicTask,
  startMusicGeneration,
  type SunoTrack,
} from "../../services/suno";

export type MusicPhase = "off" | "generating" | "partial" | "ready" | "error";

export interface MusicState {
  phase: MusicPhase;
  brief: MusicBrief | null;
  taskId: string | null;
  tracks: SunoTrack[];
  committedTrackId: string | null;
  error: string | null;
  /** epoch ms generate() was called — drives the "generating…(Xs)" status. */
  startedAtMs: number | null;
}

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 10 * 60 * 1000;

const initialState: MusicState = {
  phase: "off",
  brief: null,
  taskId: null,
  tracks: [],
  committedTrackId: null,
  error: null,
  startedAtMs: null,
};

export function useMusic() {
  const [state, setState] = useState<MusicState>(initialState);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  // Consecutive poll failures. The task keeps generating server-side through
  // a local network blip, and "retry" starts a NEW paid task — so only give
  // up on polling after several misses in a row.
  const pollFailsRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      clearTimer();
    },
    [clearTimer],
  );

  /** One poll tick; reschedules itself unless the task settled or timed out. */
  const scheduleNext = useCallback(
    (taskId: string, startedAtMs: number) => {
      timerRef.current = setTimeout(async () => {
        if (cancelledRef.current) return;
        try {
          const result = await pollMusicTask(taskId);
          if (cancelledRef.current) return;
          pollFailsRef.current = 0;
          if (result.status === "failed") {
            runningRef.current = false;
            setState((s) => ({
              ...s,
              phase: "error",
              tracks: result.tracks,
              error: result.errorMessage ?? "music generation failed",
            }));
            return;
          }
          if (result.status === "ready") {
            runningRef.current = false;
            setState((s) => ({ ...s, phase: "ready", tracks: result.tracks }));
            return;
          }
          // pending or partial: surface whatever tracks have landed so far
          setState((s) => ({
            ...s,
            phase: result.tracks.length > 0 ? "partial" : "generating",
            tracks: result.tracks,
          }));
          if (Date.now() - startedAtMs > TIMEOUT_MS) {
            runningRef.current = false;
            setState((s) => ({
              ...s,
              phase: "error",
              error: "timed out waiting for the music generation to finish",
            }));
            return;
          }
          scheduleNext(taskId, startedAtMs);
        } catch (err) {
          if (cancelledRef.current) return;
          pollFailsRef.current += 1;
          if (pollFailsRef.current < 3 && Date.now() - startedAtMs <= TIMEOUT_MS) {
            scheduleNext(taskId, startedAtMs);
            return;
          }
          runningRef.current = false;
          setState((s) => ({
            ...s,
            phase: "error",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }, POLL_INTERVAL_MS);
    },
    [],
  );

  const generate = useCallback(
    (
      userBrief: string,
      storyboard: Storyboard | null,
      targetS: number | null,
      sceneHints: string[],
      styleMusicHint?: string | null,
    ) => {
      if (runningRef.current) return; // guard against a duplicate start
      runningRef.current = true;
      cancelledRef.current = false;
      pollFailsRef.current = 0;
      clearTimer();
      const startedAtMs = Date.now();
      setState({ ...initialState, phase: "generating", startedAtMs });
      void (async () => {
        try {
          const brief = await generateMusicBrief(
            userBrief,
            storyboard,
            targetS,
            sceneHints,
            styleMusicHint,
          );
          if (cancelledRef.current) return;
          setState((s) => ({ ...s, brief }));
          const taskId = await startMusicGeneration(brief);
          if (cancelledRef.current) return;
          setState((s) => ({ ...s, taskId }));
          scheduleNext(taskId, startedAtMs);
        } catch (err) {
          if (cancelledRef.current) return;
          runningRef.current = false;
          setState((s) => ({
            ...s,
            phase: "error",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      })();
    },
    [clearTimer, scheduleNext],
  );

  const commit = useCallback((trackId: string) => {
    setState((s) => ({ ...s, committedTrackId: trackId }));
  }, []);

  const reset = useCallback(() => {
    runningRef.current = false;
    cancelledRef.current = true;
    clearTimer();
    setState(initialState);
  }, [clearTimer]);

  return { state, generate, commit, reset };
}

export type UseMusicReturn = ReturnType<typeof useMusic>;
