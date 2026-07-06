import { describe, expect, it } from "vitest";
import {
  DIRECT_MAX_ROUNDS,
  DirectorLoopError,
  REFINE_MAX_ROUNDS,
  runDirectorLoop,
  type DirectorLoopDeps,
} from "../director-loop";
import type {
  AssistantTurn,
  ChatMessage,
  DirectorActivity,
  ToolCall,
  ToolDef,
} from "../director-types";
import type { SearchResult } from "../retrieval";
import { makeDossier, makeShot } from "./director-fixtures";

const dossiers = [makeDossier({ clipId: "clip-a", fileName: "a.mp4" })];

const validItem = { clipId: "clip-a", shotIndex: 1, in: 11, out: 16, role: "hook", why: "x" };

function searchCall(id: string, query: string): ToolCall {
  return { id, type: "function", function: { name: "search_shots", arguments: JSON.stringify({ query }) } };
}

function submitCall(id: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name: "submit_storyboard",
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

function turn(content: string | null, ...tool_calls: ToolCall[]): AssistantTurn {
  return tool_calls.length > 0 ? { role: "assistant", content, tool_calls } : { role: "assistant", content };
}

const emptySearch: SearchResult = { hits: [], mean: 0, std: 0 };
const oneHit: SearchResult = {
  hits: [{ clipId: "clip-a", fileName: "a.mp4", shot: makeShot(1, 10, 25), score: 0.3, confident: true }],
  mean: 0.18,
  std: 0.02,
};

/** Deps whose `complete` replays a script of assistant turns. */
function scripted(
  turns: AssistantTurn[],
  over: Partial<DirectorLoopDeps> = {},
): DirectorLoopDeps & {
  calls: { messages: ChatMessage[]; toolChoice?: "auto" | { name: string } }[];
} {
  const calls: { messages: ChatMessage[]; toolChoice?: "auto" | { name: string } }[] = [];
  return {
    calls,
    complete: async (messages: ChatMessage[], _tools: ToolDef[], toolChoice?: "auto" | { name: string }) => {
      calls.push({ messages: [...messages], toolChoice });
      const next = turns.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    },
    search: async () => oneHit,
    dossiers,
    targetDurationS: null,
    ...over,
  };
}

const seed: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "brief" },
];

describe("runDirectorLoop", () => {
  it("runs search then accepts a valid submission", async () => {
    const activities: DirectorActivity[] = [];
    const deps = scripted(
      [
        turn("let me look for the hook", searchCall("c1", "person eating")),
        turn(null, submitCall("c2", { items: [validItem] })),
      ],
      { onActivity: (a) => activities.push(a) },
    );
    const result = await runDirectorLoop(seed, deps);

    expect(result.storyboard.items).toHaveLength(1);
    expect(result.storyboard.items[0].fileName).toBe("a.mp4");
    const last = result.messages[result.messages.length - 1];
    expect(last).toMatchObject({ role: "tool", tool_call_id: "c2", content: "Storyboard accepted." });
    expect(activities.map((a) => a.kind)).toEqual(["round", "note", "search", "round"]);
    expect(activities[2]).toMatchObject({ kind: "search", query: "person eating", hitCount: 1, confidentCount: 1 });
  });

  it("feeds validation errors back and accepts the corrected resubmit", async () => {
    const activities: DirectorActivity[] = [];
    const deps = scripted(
      [
        turn(null, submitCall("c1", { items: [{ ...validItem, clipId: "nope" }] })),
        turn(null, submitCall("c2", { items: [validItem] })),
      ],
      { onActivity: (a) => activities.push(a) },
    );
    const result = await runDirectorLoop(seed, deps);

    expect(result.storyboard.items).toHaveLength(1);
    const rejection = result.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    ) as Extract<ChatMessage, { role: "tool" }>;
    expect(rejection.content).toContain("REJECTED");
    expect(rejection.content).toContain('unknown clipId "nope"');
    expect(activities.some((a) => a.kind === "rejected")).toBe(true);
  });

  it("answers every tool_call id, including parallel calls", async () => {
    const deps = scripted([
      turn(null, searchCall("c1", "market"), searchCall("c2", "dog")),
      turn(null, submitCall("c3", { items: [validItem] })),
    ]);
    const result = await runDirectorLoop(seed, deps);

    const toolIds = result.messages
      .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool")
      .map((m) => m.tool_call_id);
    expect(toolIds).toEqual(["c1", "c2", "c3"]);
  });

  it("runs a round's search calls concurrently and replies in call order", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (r: SearchResult) => void>();
    const deps = scripted(
      [
        turn(null, searchCall("c1", "market"), searchCall("c2", "dog")),
        turn(null, submitCall("c3", { items: [validItem] })),
      ],
      {
        search: (query) => {
          started.push(query);
          return new Promise<SearchResult>((resolve) => resolvers.set(query, resolve));
        },
      },
    );
    const run = runDirectorLoop(seed, deps);
    // Both searches must be in flight before EITHER has resolved (the old
    // sequential loop only started the second after the first finished).
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["market", "dog"]);
    // Resolve out of order: replies must still land in call order.
    resolvers.get("dog")!(oneHit);
    resolvers.get("market")!(oneHit);
    const result = await run;
    const toolIds = result.messages
      .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool")
      .map((m) => m.tool_call_id);
    expect(toolIds).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps per-call error replies when one concurrent search fails", async () => {
    const deps = scripted(
      [
        turn(null, searchCall("c1", "market"), searchCall("c2", "dog")),
        turn(null, submitCall("c3", { items: [validItem] })),
      ],
      {
        search: async (query) => {
          if (query === "market") throw new Error("index unavailable");
          return oneHit;
        },
      },
    );
    const result = await runDirectorLoop(seed, deps);
    const byId = new Map(
      result.messages
        .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool")
        .map((m) => [m.tool_call_id, m.content]),
    );
    expect(byId.get("c1")).toContain("search_shots error: index unavailable");
    expect(byId.get("c2")).toContain('search_shots("dog")');
  });

  it("nudges a prose-only turn back onto the tools", async () => {
    const deps = scripted([
      turn("I think I will pick the eating shots."),
      turn(null, submitCall("c1", { items: [validItem] })),
    ]);
    const result = await runDirectorLoop(seed, deps);

    const nudge = result.messages.find(
      (m) => m.role === "user" && m.content.includes("Use the tools"),
    );
    expect(nudge).toBeDefined();
    expect(result.storyboard.items).toHaveLength(1);
  });

  it("replies to unknown tool names without crashing", async () => {
    const badCall: ToolCall = {
      id: "c1",
      type: "function",
      function: { name: "delete_everything", arguments: "{}" },
    };
    const deps = scripted([
      turn(null, badCall),
      turn(null, submitCall("c2", { items: [validItem] })),
    ]);
    const result = await runDirectorLoop(seed, deps);
    const reply = result.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    ) as Extract<ChatMessage, { role: "tool" }>;
    expect(reply.content).toContain("unknown tool");
  });

  it("forces submit_storyboard on the last round and salvages a partial submission", async () => {
    const deps = scripted(
      [
        turn(null, searchCall("c1", "market")),
        // Last round: one bad item, one good — salvage the good one.
        turn(null, submitCall("c2", { items: [{ ...validItem, clipId: "nope" }, validItem] })),
      ],
      { maxRounds: 2 },
    );
    const result = await runDirectorLoop(seed, deps);

    expect(deps.calls[0].toolChoice).toBe("auto");
    expect(deps.calls[1].toolChoice).toEqual({ name: "submit_storyboard" });
    expect(result.storyboard.items).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("unknown clipId"))).toBe(true);
  });

  it("throws no-storyboard when even the forced submit is unusable", async () => {
    const deps = scripted([turn(null, submitCall("c1", "{broken"))], { maxRounds: 1 });
    await expect(runDirectorLoop(seed, deps)).rejects.toMatchObject({
      name: "DirectorLoopError",
      code: "no-storyboard",
    });
  });

  it("throws aborted without calling the model when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = scripted([turn(null, submitCall("c1", { items: [validItem] }))], {
      signal: controller.signal,
    });
    await expect(runDirectorLoop(seed, deps)).rejects.toMatchObject({ code: "aborted" });
    expect(deps.calls).toHaveLength(0);
  });

  it("wraps model call failures as api errors", async () => {
    const deps = scripted([], {
      complete: async () => {
        throw new Error("502 bad gateway");
      },
    });
    const err = await runDirectorLoop(seed, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectorLoopError);
    expect((err as DirectorLoopError).code).toBe("api");
    expect((err as DirectorLoopError).message).toContain("502");
  });

  it("replies with an error to search calls missing a query", async () => {
    const badSearch: ToolCall = {
      id: "c1",
      type: "function",
      function: { name: "search_shots", arguments: "{}" },
    };
    const deps = scripted([
      turn(null, badSearch),
      turn(null, submitCall("c2", { items: [validItem] })),
    ]);
    const result = await runDirectorLoop(seed, deps);
    const reply = result.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "c1",
    ) as Extract<ChatMessage, { role: "tool" }>;
    expect(reply.content).toContain('"query"');
    void emptySearch;
  });

  describe("round caps", () => {
    const brokenSubmits = (n: number) =>
      Array.from({ length: n }, (_, i) => turn(null, submitCall(`c${i}`, "{broken")));
    const refineSeed: ChatMessage[] = [
      ...seed,
      { role: "assistant", content: "here is the storyboard" },
      { role: "user", content: "USER FEEDBACK: tighter" },
    ];

    it("caps a direct run at DIRECT_MAX_ROUNDS", async () => {
      const deps = scripted(brokenSubmits(DIRECT_MAX_ROUNDS + 2));
      await expect(runDirectorLoop(seed, deps)).rejects.toMatchObject({ code: "no-storyboard" });
      expect(deps.calls).toHaveLength(DIRECT_MAX_ROUNDS);
    });

    it("caps a refine (seed already holds assistant turns) at REFINE_MAX_ROUNDS", async () => {
      const deps = scripted(brokenSubmits(DIRECT_MAX_ROUNDS + 2));
      await expect(runDirectorLoop(refineSeed, deps)).rejects.toMatchObject({
        code: "no-storyboard",
      });
      expect(deps.calls).toHaveLength(REFINE_MAX_ROUNDS);
      expect(deps.calls[REFINE_MAX_ROUNDS - 1].toolChoice).toEqual({ name: "submit_storyboard" });
    });

    it("honors an explicit mode over the seed heuristic", async () => {
      const deps = scripted(brokenSubmits(DIRECT_MAX_ROUNDS + 2), { mode: "refine" });
      await expect(runDirectorLoop(seed, deps)).rejects.toMatchObject({ code: "no-storyboard" });
      expect(deps.calls).toHaveLength(REFINE_MAX_ROUNDS);
    });
  });

  describe("salvage duration handling", () => {
    // Fixture shots: #0 0-10s, #1 10-25s, #2 25-60s.
    const threeTens = [
      { clipId: "clip-a", shotIndex: 0, in: 0, out: 10, role: "hook", why: "x" },
      { clipId: "clip-a", shotIndex: 1, in: 10, out: 20, role: "action", why: "x" },
      { clipId: "clip-a", shotIndex: 2, in: 25, out: 35, role: "outro", why: "x" },
    ];

    it("mechanically trims an over-target salvage toward the target", async () => {
      const deps = scripted([turn(null, submitCall("c1", { items: threeTens }))], {
        maxRounds: 1,
        targetDurationS: 12,
      });
      const result = await runDirectorLoop(seed, deps);
      // 30s submitted: drop the 10s tail (20s left), shorten the next by 8s.
      expect(result.storyboard.items).toHaveLength(2);
      expect(result.storyboard.items[1]).toMatchObject({ inS: 10, outS: 12 });
      expect(result.durationViolation).toEqual({
        targetS: 12,
        submittedS: 30,
        deliveredS: 12,
        direction: "over",
        trimmed: true,
      });
      expect(result.warnings[0]).toContain("DURATION");
      expect(result.warnings[0]).toContain("trimmed to 12.0s");
    });

    it("flags an under-target salvage without trimming", async () => {
      const deps = scripted([turn(null, submitCall("c1", { items: [validItem] }))], {
        maxRounds: 1,
        targetDurationS: 30,
      });
      const result = await runDirectorLoop(seed, deps);
      expect(result.storyboard.items).toHaveLength(1);
      expect(result.durationViolation).toEqual({
        targetS: 30,
        submittedS: 5,
        deliveredS: 5,
        direction: "under",
        trimmed: false,
      });
      expect(result.warnings[0]).toContain("DURATION");
    });

    it("reports no violation on a normal accept", async () => {
      const deps = scripted([turn(null, submitCall("c1", { items: [validItem] }))], {
        targetDurationS: 5,
      });
      const result = await runDirectorLoop(seed, deps);
      expect(result.durationViolation).toBeNull();
    });
  });

  it("reports mid-speech-cut and adjacent-cosine metrics on the result", async () => {
    const e = (x: number, y: number) => Float32Array.from([x, y]);
    const withData = [
      makeDossier({
        clipId: "clip-a",
        fileName: "a.mp4",
        shots: [makeShot(0, 0, 10, { embedding: e(1, 0) }), makeShot(1, 10, 25, { embedding: e(1, 0) })],
        transcript: [{ t0: 2, t1: 6, text: "a full spoken sentence" }],
      }),
    ];
    const items = [
      // out=4 lands 2s inside the 2-6s segment: too deep to snap, mid-speech.
      { clipId: "clip-a", shotIndex: 0, in: 0, out: 4, role: "hook", why: "x" },
      { clipId: "clip-a", shotIndex: 1, in: 10, out: 15, role: "b-roll", why: "x" },
    ];
    const deps = scripted([turn(null, submitCall("c1", { items }))], { dossiers: withData });
    const result = await runDirectorLoop(seed, deps);
    expect(result.metrics).toMatchObject({
      cutCount: 4,
      midSpeechCutCount: 1,
      midSpeechCutFraction: 0.25,
      adjacentPairCount: 1,
    });
    expect(result.metrics.adjacentCosineMean).toBeCloseTo(1);
    expect(result.metrics.adjacentCosineMax).toBeCloseTo(1);
    expect(result.durationViolation).toBeNull();
  });
});
