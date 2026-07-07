import { describe, expect, it } from "vitest";
import {
  fmtBytes,
  fmtCompactNumber,
  fmtCostCell,
  fmtDateOnly,
  fmtDateTime,
  fmtDurationHM,
  fmtExactUSD,
  fmtKnownCostUSD,
  fmtQuotaLimit,
  fmtQuotaUsageValue,
} from "./format";

describe("fmtExactUSD", () => {
  it("always renders 4 decimal places", () => {
    expect(fmtExactUSD(0.0182)).toBe("$0.0182");
    expect(fmtExactUSD(1)).toBe("$1.0000");
    expect(fmtExactUSD(0)).toBe("$0.0000");
  });
});

describe("fmtKnownCostUSD", () => {
  it("renders null as an em-dash, never $0.00", () => {
    expect(fmtKnownCostUSD(null)).toBe("—");
  });

  it("renders a real zero as an exact dollar figure, not a dash", () => {
    // A distinct case from null: some rows genuinely cost $0 exactly (should
    // never happen in practice for billed categories, but the type permits
    // it) — only `null` means "unknown", so 0 must still render as $0.0000.
    expect(fmtKnownCostUSD(0)).toBe("$0.0000");
  });

  it("renders a known cost exactly", () => {
    expect(fmtKnownCostUSD(0.0182)).toBe("$0.0182");
  });
});

describe("fmtCostCell", () => {
  it("renders a bare dash with no events at all", () => {
    expect(fmtCostCell(null, 0, 0).text).toBe("—");
  });

  it("renders the exact honesty-fraction example from the spec", () => {
    expect(fmtCostCell(0.0182, 3, 5).text).toBe("$0.0182 · 3/5 costed");
  });

  it("renders '0/N costed' when there was activity but zero known cost, never $0.00", () => {
    const cell = fmtCostCell(null, 0, 4);
    expect(cell.text).toBe("— · 0/4 costed");
    expect(cell.text).not.toContain("$0.00");
  });

  it("renders the full fraction when every event was costed", () => {
    expect(fmtCostCell(1.5, 5, 5).text).toBe("$1.5000 · 5/5 costed");
  });
});

describe("fmtCompactNumber", () => {
  it("keeps small numbers exact", () => {
    expect(fmtCompactNumber(950)).toBe("950");
    expect(fmtCompactNumber(0)).toBe("0");
  });

  it("compacts thousands to one decimal + k", () => {
    expect(fmtCompactNumber(1234)).toBe("1.2k");
    expect(fmtCompactNumber(40000)).toBe("40.0k");
  });
});

describe("fmtDurationHM", () => {
  it("floors to 0m at zero/negative", () => {
    expect(fmtDurationHM(0)).toBe("0m");
    expect(fmtDurationHM(-5)).toBe("0m");
  });

  it("shows <1m under a minute", () => {
    expect(fmtDurationHM(45)).toBe("<1m");
  });

  it("rounds to whole minutes under an hour", () => {
    expect(fmtDurationHM(185)).toBe("3m");
  });

  it("shows hours + minutes over an hour", () => {
    expect(fmtDurationHM(5410)).toBe("1h 30m");
  });
});

describe("fmtBytes", () => {
  it("picks the largest sensible unit", () => {
    expect(fmtBytes(500)).toBe("500B");
    expect(fmtBytes(2_500)).toBe("2.5KB");
    expect(fmtBytes(3_400_000)).toBe("3.4MB");
    expect(fmtBytes(5_400_000_000)).toBe("5.4GB");
  });
});

describe("fmtQuotaLimit", () => {
  it("renders null as unlimited (first-class per QuotaLimits)", () => {
    expect(fmtQuotaLimit(null)).toBe("unlimited");
  });

  it("renders a finite limit as a comma-grouped integer", () => {
    expect(fmtQuotaLimit(1000000)).toBe("1,000,000");
  });
});

describe("fmtQuotaUsageValue", () => {
  it("formats sttSeconds as duration", () => {
    expect(fmtQuotaUsageValue("sttSeconds", 185)).toBe("3m");
  });

  it("formats sunoGens as a plain integer", () => {
    expect(fmtQuotaUsageValue("sunoGens", 3)).toBe("3");
  });

  it("formats token/frame categories compactly", () => {
    expect(fmtQuotaUsageValue("directorTokens", 42000)).toBe("42.0k");
    expect(fmtQuotaUsageValue("cloudCaptionFrames", 12)).toBe("12");
  });
});

describe("fmtDateTime / fmtDateOnly", () => {
  it("renders null/undefined/invalid as a dash", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(fmtDateTime("not-a-date")).toBe("—");
    expect(fmtDateOnly(null)).toBe("—");
  });

  it("renders a UTC-stable minute-precision timestamp", () => {
    expect(fmtDateTime("2026-07-07T14:32:11.000Z")).toBe("2026-07-07 14:32");
  });

  it("renders date-only truncation", () => {
    expect(fmtDateOnly("2026-07-07T14:32:11.000Z")).toBe("2026-07-07");
  });
});
