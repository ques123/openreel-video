/**
 * costCellFor: the provider- and completeness-aware $ cell decision behind
 * PerfPanel's Captioning totals — the fix for the $0.11-vs-$0.20 OpenRouter
 * undercount (see docs referenced in model-pricing.ts's MODEL_PRICING
 * header). estimateCostUSD/fmtUSD themselves are exercised indirectly
 * throughout enhance-cost.test.ts/experiments.test.ts; this file covers only
 * the new display-decision logic.
 */

import { describe, expect, it } from "vitest";
import {
  ACTUAL_COST_TITLE,
  OPENROUTER_ESTIMATE_TITLE,
  PRE_TRACKING_ESTIMATE_TITLE,
  costCellFor,
} from "./model-pricing";

const OPENROUTER_MODEL = "qwen/qwen3-vl-235b-a22b-instruct";
const OPENAI_MODEL = "gpt-5.2";

describe("costCellFor", () => {
  it("shows a plain exact $ when the actual billed cost is known", () => {
    const cell = costCellFor(OPENROUTER_MODEL, 0.204, 0.11, false);
    expect(cell).toEqual({ text: "$0.20", title: ACTUAL_COST_TITLE, estimated: false });
  });

  it("tildes an OpenRouter estimate and explains the routing risk — the $0.11-vs-$0.20 trap", () => {
    const cell = costCellFor(OPENROUTER_MODEL, null, 0.11, false);
    expect(cell.text).toBe("~$0.11");
    expect(cell.title).toBe(OPENROUTER_ESTIMATE_TITLE);
    expect(cell.estimated).toBe(true);
  });

  it("keeps an OpenAI measured-token estimate plain (single provider, token×rate IS exact)", () => {
    const cell = costCellFor(OPENAI_MODEL, null, 1.56, false);
    expect(cell).toEqual({ text: "$1.56", title: undefined, estimated: false });
  });

  it("always tildes the pre-tracking (backfilled per-frame-rate) estimate, any provider", () => {
    const openai = costCellFor(OPENAI_MODEL, null, 0.42, true);
    expect(openai.text).toBe("~$0.42");
    expect(openai.title).toBe(PRE_TRACKING_ESTIMATE_TITLE);
    expect(openai.estimated).toBe(true);

    const openrouter = costCellFor(OPENROUTER_MODEL, null, 0.42, true);
    expect(openrouter.text).toBe("~$0.42");
    // Pre-tracking wins over the OpenRouter-routing title — the reason for
    // the estimate here is "no tokens recorded at all", not routing variance.
    expect(openrouter.title).toBe(PRE_TRACKING_ESTIMATE_TITLE);
  });

  it("ignores a stray actualCostUSD on a pre-tracking row (pre-tracking rows never truly have one)", () => {
    const cell = costCellFor(OPENROUTER_MODEL, 0.5, 0.42, true);
    expect(cell.text).toBe("~$0.42");
    expect(cell.title).toBe(PRE_TRACKING_ESTIMATE_TITLE);
  });

  it("renders a dash when neither an actual nor an estimate is available", () => {
    expect(costCellFor(OPENAI_MODEL, null, null, false)).toEqual({
      text: "—",
      title: undefined,
      estimated: false,
    });
    expect(costCellFor(OPENROUTER_MODEL, null, null, true)).toEqual({
      text: "—",
      title: undefined,
      estimated: false,
    });
  });
});
