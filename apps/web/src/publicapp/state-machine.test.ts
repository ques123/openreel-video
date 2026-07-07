import { describe, expect, it } from "vitest";
import type { GenerateFlowState } from "@wizz/contracts";
import { applyEvent, INITIAL_FLOW_STATE, telemetryForTransition } from "./state-machine";

describe("applyEvent", () => {
  it("routes to needs-auth on SESSION_MISSING from any state", () => {
    const states: GenerateFlowState[] = [
      { name: "bench", allReady: true },
      { name: "screening", rendering: false },
      { name: "gate-unsupported" },
    ];
    for (const s of states) {
      expect(applyEvent(s, { type: "SESSION_MISSING" })).toEqual({ name: "needs-auth" });
    }
  });

  it("routes to gate-unsupported on UNSUPPORTED_BROWSER from any state", () => {
    expect(applyEvent(INITIAL_FLOW_STATE, { type: "UNSUPPORTED_BROWSER" })).toEqual({
      name: "gate-unsupported",
    });
  });

  it("SESSION_OK lands on a first-visit empty studio", () => {
    expect(applyEvent({ name: "needs-auth" }, { type: "SESSION_OK" })).toEqual({
      name: "studio-empty",
      firstVisit: true,
    });
  });

  describe("the restore-offer path", () => {
    it("RESTORE_AVAILABLE only fires from studio-empty", () => {
      const from = { name: "studio-empty", firstVisit: false } as const;
      expect(
        applyEvent(from, { type: "RESTORE_AVAILABLE", clipCount: 12, label: "Tuesday's footage" }),
      ).toEqual({ name: "studio-restore-offer", clipCount: 12, label: "Tuesday's footage" });

      // Ignored from an unrelated state (guarded no-op).
      const bench = { name: "bench", allReady: true } as const;
      expect(
        applyEvent(bench, { type: "RESTORE_AVAILABLE", clipCount: 12, label: "x" }),
      ).toBe(bench);
    });

    it("RESTORE_ACCEPTED moves to an analyzing bench", () => {
      const from = { name: "studio-restore-offer", clipCount: 12, label: "x" } as const;
      expect(applyEvent(from, { type: "RESTORE_ACCEPTED" })).toEqual({
        name: "bench",
        allReady: false,
      });
    });

    it("RESTORE_DECLINED returns to a non-first-visit empty studio", () => {
      const from = { name: "studio-restore-offer", clipCount: 12, label: "x" } as const;
      expect(applyEvent(from, { type: "RESTORE_DECLINED" })).toEqual({
        name: "studio-empty",
        firstVisit: false,
      });
    });
  });

  describe("the bench", () => {
    it("CLIPS_ADDED arms the bench from studio-empty or an already-ready bench", () => {
      expect(
        applyEvent({ name: "studio-empty", firstVisit: true }, { type: "CLIPS_ADDED" }),
      ).toEqual({ name: "bench", allReady: false });
      expect(applyEvent({ name: "bench", allReady: true }, { type: "CLIPS_ADDED" })).toEqual({
        name: "bench",
        allReady: false,
      });
    });

    it("ALL_CLIPS_READY only flips allReady from the bench", () => {
      expect(applyEvent({ name: "bench", allReady: false }, { type: "ALL_CLIPS_READY" })).toEqual({
        name: "bench",
        allReady: true,
      });
      const notBench = { name: "needs-auth" } as const;
      expect(applyEvent(notBench, { type: "ALL_CLIPS_READY" })).toBe(notBench);
    });

    it("CLIPS_CHANGED conservatively resets allReady to false", () => {
      expect(applyEvent({ name: "bench", allReady: true }, { type: "CLIPS_CHANGED" })).toEqual({
        name: "bench",
        allReady: false,
      });
    });

    it("GENERATE only fires when the bench is allReady", () => {
      const notReady = { name: "bench", allReady: false } as const;
      expect(applyEvent(notReady, { type: "GENERATE" })).toBe(notReady);

      const ready = { name: "bench", allReady: true } as const;
      expect(applyEvent(ready, { type: "GENERATE" })).toEqual({
        name: "directing",
        sinceRefine: false,
      });
    });
  });

  describe("directing outcomes", () => {
    const directing = { name: "directing", sinceRefine: false } as const;

    it("DIRECTOR_DONE goes to screening, not rendering", () => {
      expect(applyEvent(directing, { type: "DIRECTOR_DONE" })).toEqual({
        name: "screening",
        rendering: false,
      });
    });

    it("DIRECTOR_CANCELLED returns to a ready bench (setup kept)", () => {
      expect(applyEvent(directing, { type: "DIRECTOR_CANCELLED" })).toEqual({
        name: "bench",
        allReady: true,
      });
    });

    it("DIRECTOR_FAILED auth_required routes to needs-auth", () => {
      expect(applyEvent(directing, { type: "DIRECTOR_FAILED", code: "auth_required" })).toEqual({
        name: "needs-auth",
      });
    });

    it("DIRECTOR_FAILED quota_exceeded uses ctx.quota when supplied", () => {
      const result = applyEvent(directing, { type: "DIRECTOR_FAILED", code: "quota_exceeded" }, {
        quota: { category: "directorTokens", resetsAt: "2026-07-08T00:00:00.000Z" },
      });
      expect(result).toEqual({
        name: "quota-exceeded",
        category: "directorTokens",
        resetsAt: "2026-07-08T00:00:00.000Z",
      });
    });

    it("DIRECTOR_FAILED quota_exceeded without ctx still produces a well-formed state", () => {
      const result = applyEvent(directing, { type: "DIRECTOR_FAILED", code: "quota_exceeded" });
      expect(result.name).toBe("quota-exceeded");
      if (result.name === "quota-exceeded") {
        expect(typeof result.category).toBe("string");
        expect(typeof result.resetsAt).toBe("string");
      }
    });

    it("DIRECTOR_FAILED rate_limited stays on directing (inline retry, not a scene change)", () => {
      expect(applyEvent(directing, { type: "DIRECTOR_FAILED", code: "rate_limited" })).toBe(
        directing,
      );
    });

    it("DIRECTOR_FAILED kill_switch/upstream_error route to service-away with the reason", () => {
      expect(applyEvent(directing, { type: "DIRECTOR_FAILED", code: "kill_switch" })).toEqual({
        name: "service-away",
        reason: "kill_switch",
      });
      expect(applyEvent(directing, { type: "DIRECTOR_FAILED", code: "upstream_error" })).toEqual({
        name: "service-away",
        reason: "upstream_error",
      });
    });
  });

  describe("screening + render", () => {
    const screening = { name: "screening", rendering: false } as const;

    it("REFINE starts a new directing round flagged sinceRefine", () => {
      expect(applyEvent(screening, { type: "REFINE" })).toEqual({
        name: "directing",
        sinceRefine: true,
      });
    });

    it("RENDER/RENDER_DONE/RENDER_CANCELLED toggle the rendering sub-state", () => {
      expect(applyEvent(screening, { type: "RENDER" })).toEqual({
        name: "screening",
        rendering: true,
      });
      const rendering = { name: "screening", rendering: true } as const;
      expect(applyEvent(rendering, { type: "RENDER_DONE" })).toEqual({
        name: "screening",
        rendering: false,
      });
      expect(applyEvent(rendering, { type: "RENDER_CANCELLED" })).toEqual({
        name: "screening",
        rendering: false,
      });
    });

    it("CHANGE_SETUP from screening, service-away, or quota-exceeded returns to a ready bench", () => {
      expect(applyEvent(screening, { type: "CHANGE_SETUP" })).toEqual({
        name: "bench",
        allReady: true,
      });
      expect(
        applyEvent({ name: "service-away", reason: "kill_switch" }, { type: "CHANGE_SETUP" }),
      ).toEqual({ name: "bench", allReady: true });
      expect(
        applyEvent(
          { name: "quota-exceeded", category: "directorTokens", resetsAt: "x" },
          { type: "CHANGE_SETUP" },
        ),
      ).toEqual({ name: "bench", allReady: true });
    });
  });

  describe("RETRY", () => {
    it("returns to a ready bench from service-away or quota-exceeded", () => {
      expect(applyEvent({ name: "service-away", reason: "upstream_error" }, { type: "RETRY" })).toEqual(
        { name: "bench", allReady: true },
      );
      expect(
        applyEvent(
          { name: "quota-exceeded", category: "sttSeconds", resetsAt: "x" },
          { type: "RETRY" },
        ),
      ).toEqual({ name: "bench", allReady: true });
    });

    it("is a no-op from unrelated states", () => {
      const bench = { name: "bench", allReady: true } as const;
      expect(applyEvent(bench, { type: "RETRY" })).toBe(bench);
    });
  });
});

describe("telemetryForTransition", () => {
  it("fires session_start on SESSION_OK", () => {
    expect(telemetryForTransition({ name: "needs-auth" }, { type: "SESSION_OK" })).toEqual([
      { type: "session_start" },
    ]);
  });

  it("fires analyze_started only when entering the bench from a valid prior state", () => {
    expect(
      telemetryForTransition({ name: "studio-empty", firstVisit: true }, { type: "CLIPS_ADDED" }),
    ).toEqual([{ type: "analyze_started" }]);
    expect(telemetryForTransition({ name: "needs-auth" }, { type: "CLIPS_ADDED" })).toEqual([]);
  });

  it("fires analyze_completed only from the bench", () => {
    expect(
      telemetryForTransition({ name: "bench", allReady: false }, { type: "ALL_CLIPS_READY" }),
    ).toEqual([{ type: "analyze_completed" }]);
    expect(telemetryForTransition({ name: "needs-auth" }, { type: "ALL_CLIPS_READY" })).toEqual([]);
  });

  it("fires generate_started only when GENERATE actually arms (bench allReady)", () => {
    expect(
      telemetryForTransition({ name: "bench", allReady: true }, { type: "GENERATE" }),
    ).toEqual([{ type: "generate_started" }]);
    expect(
      telemetryForTransition({ name: "bench", allReady: false }, { type: "GENERATE" }),
    ).toEqual([]);
  });

  it("fires generate_succeeded/generate_failed from directing", () => {
    const directing = { name: "directing", sinceRefine: true } as const;
    expect(telemetryForTransition(directing, { type: "DIRECTOR_DONE" })).toEqual([
      { type: "generate_succeeded" },
    ]);
    expect(
      telemetryForTransition(directing, { type: "DIRECTOR_FAILED", code: "upstream_error" }),
    ).toEqual([{ type: "generate_failed", data: { code: "upstream_error", sinceRefine: true } }]);
  });

  it("fires refine_started, export_started, export_completed from screening", () => {
    const screening = { name: "screening", rendering: false } as const;
    expect(telemetryForTransition(screening, { type: "REFINE" })).toEqual([
      { type: "refine_started" },
    ]);
    expect(telemetryForTransition(screening, { type: "RENDER" })).toEqual([
      { type: "export_started" },
    ]);
    expect(telemetryForTransition(screening, { type: "RENDER_DONE" })).toEqual([
      { type: "export_completed" },
    ]);
  });

  it("emits nothing for events with no telemetry mapping", () => {
    expect(telemetryForTransition({ name: "bench", allReady: true }, { type: "CLIPS_CHANGED" })).toEqual(
      [],
    );
    expect(
      telemetryForTransition({ name: "screening", rendering: true }, { type: "RENDER_CANCELLED" }),
    ).toEqual([]);
  });
});
