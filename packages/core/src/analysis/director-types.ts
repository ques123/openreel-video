/**
 * Director types: the storyboard IR, the OpenAI chat-completions wire shapes
 * the loop speaks (hand-rolled — no SDK dependency), and the live activity
 * events the UI renders while a run is in flight.
 *
 * The director is an LLM that has read the dossier TEXT but never the pixels.
 * It grounds visual claims through the search_shots tool (local CLIP
 * retrieval) and terminates by calling submit_storyboard exactly once.
 */

/** One ordered segment of the proposed cut. */
export interface StoryboardItem {
  clipId: string;
  /** Resolved from the dossier — never trusted from the model. */
  fileName: string;
  /** Shot the range was anchored to, or null when the model gave a raw range. */
  shotIndex: number | null;
  /** Trim range within the source clip, seconds (clamped by validation). */
  inS: number;
  outS: number;
  /** Editorial function, e.g. "hook", "context", "action", "b-roll", "outro". */
  role: string;
  /** The model's one-line justification for the pick. */
  why: string;
  /** Representative thumbnail of the covering shot, for the UI. */
  thumbnailDataUrl: string | null;
}

export interface Storyboard {
  title: string | null;
  notes: string | null;
  items: StoryboardItem[];
}

export function storyboardDurationS(storyboard: Storyboard): number {
  let total = 0;
  for (const item of storyboard.items) total += item.outS - item.inS;
  return total;
}

// ---------------------------------------------------------------------------
// OpenAI chat-completions wire types (the subset the loop uses).
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AssistantTurn = Extract<ChatMessage, { role: "assistant" }>;

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const SEARCH_SHOTS_TOOL = "search_shots";
export const SUBMIT_STORYBOARD_TOOL = "submit_storyboard";

export const DIRECTOR_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: SEARCH_SHOTS_TOOL,
      description:
        "Search all analyzed shots by visual content (CLIP text-to-image retrieval). " +
        "Use short caption-style descriptions of what would be VISIBLE in a frame.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Caption-style visual description, e.g. "a person cutting open a durian".',
          },
          topK: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "How many hits to return (default 8).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SUBMIT_STORYBOARD_TOOL,
      description:
        "Submit the final storyboard. Call exactly once, when the cut is decided. " +
        "If it is rejected with errors, fix them and resubmit.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the cut." },
          notes: { type: "string", description: "Anything the editor should know." },
          items: {
            type: "array",
            minItems: 1,
            description: "Segments in playback order.",
            items: {
              type: "object",
              properties: {
                clipId: { type: "string", description: "CLIP id from the dossier." },
                shotIndex: {
                  type: "integer",
                  description: "Shot the range sits in (from the dossier or search hits).",
                },
                in: { type: "number", description: "Trim start, seconds within the clip." },
                out: { type: "number", description: "Trim end, seconds within the clip." },
                role: {
                  type: "string",
                  description: 'Editorial function: "hook", "context", "action", "b-roll", …',
                },
                why: { type: "string", description: "One line: why this segment, here." },
              },
              required: ["clipId", "in", "out", "role", "why"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Live activity surfaced to the UI during a run.
// ---------------------------------------------------------------------------

export type DirectorActivity =
  | { kind: "round"; round: number }
  | { kind: "search"; query: string; hitCount: number; confidentCount: number }
  /** Assistant prose emitted between tool calls (thinking out loud). */
  | { kind: "note"; text: string }
  /** A submit_storyboard call bounced by validation; errors were fed back. */
  | { kind: "rejected"; errors: string[] };
