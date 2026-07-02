import { describe, expect, it } from "vitest";
import {
  DirectorLoopError,
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
});
