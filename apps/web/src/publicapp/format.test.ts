import { describe, expect, it } from "vitest";
import {
  capitalize,
  fmtBatchLine,
  fmtChipLabel,
  fmtClipsSummary,
  fmtClockHHMMSS,
  fmtClockMMSS,
  fmtDurationShort,
  fmtEtaLeft,
  fmtQuotaCategory,
  fmtResetsAt,
  nextUtcMidnightIso,
  relativeDayLabel,
  restoreOfferLabel,
} from "./format";

describe("fmtDurationShort", () => {
  it("formats sub-minute and multi-minute durations without zero-padded minutes", () => {
    expect(fmtDurationShort(58)).toBe("0:58");
    expect(fmtDurationShort(252)).toBe("4:12");
    expect(fmtDurationShort(0)).toBe("0:00");
  });
});

describe("fmtClockMMSS", () => {
  it("zero-pads both minutes and seconds", () => {
    expect(fmtClockMMSS(0)).toBe("00:00");
    expect(fmtClockMMSS(58)).toBe("00:58");
    expect(fmtClockMMSS(65)).toBe("01:05");
  });
});

describe("fmtClockHHMMSS", () => {
  it("formats a full HH:MM:SS timecode", () => {
    expect(fmtClockHHMMSS(0)).toBe("00:00:00");
    expect(fmtClockHHMMSS(58)).toBe("00:00:58");
    expect(fmtClockHHMMSS(3661)).toBe("01:01:01");
  });
});

describe("fmtEtaLeft", () => {
  it("rounds to whole minutes and pluralizes correctly", () => {
    expect(fmtEtaLeft(540)).toBe("about 9 minutes left");
    expect(fmtEtaLeft(60)).toBe("about 1 minute left");
    expect(fmtEtaLeft(0)).toBe("about 1 minute left"); // never claims 0 minutes left
    expect(fmtEtaLeft(89)).toBe("about 1 minute left");
    expect(fmtEtaLeft(91)).toBe("about 2 minutes left");
  });
});

describe("fmtBatchLine", () => {
  it("reports 1-based clip position, clamped to total", () => {
    expect(fmtBatchLine(0, 12)).toBe("Understanding your footage — clip 1 of 12");
    expect(fmtBatchLine(11, 12)).toBe("Understanding your footage — clip 12 of 12");
    expect(fmtBatchLine(99, 12)).toBe("Understanding your footage — clip 12 of 12");
  });
});

describe("relativeDayLabel", () => {
  const day = 86_400_000;
  const now = new Date(2026, 6, 7, 10, 0, 0).getTime(); // Tue Jul 7 2026, 10:00 local

  it("labels the same calendar day as today", () => {
    expect(relativeDayLabel(now - 1000, now)).toBe("today");
  });

  it("labels the previous calendar day as yesterday, even across a late-night save", () => {
    const lateLastNight = new Date(2026, 6, 6, 23, 0, 0).getTime();
    expect(relativeDayLabel(lateLastNight, now)).toBe("yesterday");
  });

  it("labels 2-6 days ago with the weekday name", () => {
    const threeDaysAgo = now - 3 * day;
    const label = relativeDayLabel(threeDaysAgo, now);
    expect(label).toBe(new Date(threeDaysAgo).toLocaleDateString(undefined, { weekday: "long" }));
  });

  it("falls back to a short date beyond a week", () => {
    const tenDaysAgo = now - 10 * day;
    expect(relativeDayLabel(tenDaysAgo, now)).toBe(
      new Date(tenDaysAgo).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });
});

describe("restoreOfferLabel", () => {
  it("appends the possessive 'footage' noun phrase", () => {
    const now = Date.now();
    expect(restoreOfferLabel(now, now)).toBe("today's footage");
  });
});

describe("fmtClipsSummary", () => {
  it("combines clip count and duration", () => {
    expect(fmtClipsSummary(12, 38 * 60)).toBe("12 clips · 38 minutes");
    expect(fmtClipsSummary(1, 60)).toBe("1 clip · 1 minute");
  });

  it("omits duration when unknown", () => {
    expect(fmtClipsSummary(9, null)).toBe("9 clips");
  });
});

describe("nextUtcMidnightIso", () => {
  it("returns the following UTC midnight as an ISO string", () => {
    const now = Date.UTC(2026, 6, 7, 15, 30, 0);
    expect(nextUtcMidnightIso(now)).toBe("2026-07-08T00:00:00.000Z");
  });
});

describe("fmtQuotaCategory", () => {
  it("renders a plain-words label for each category", () => {
    expect(fmtQuotaCategory("directorTokens")).toBe("today's directing budget");
    expect(fmtQuotaCategory("sunoGens")).toBe("today's music budget");
    expect(fmtQuotaCategory("cloudCaptionFrames")).toBe("today's cloud captioning budget");
    expect(fmtQuotaCategory("sttSeconds")).toBe("today's cloud transcription budget");
  });
});

describe("fmtChipLabel", () => {
  it("matches the wireframe's default duration chips exactly", () => {
    expect(fmtChipLabel(30)).toBe("30s");
    expect(fmtChipLabel(60)).toBe("60s");
    expect(fmtChipLabel(90)).toBe("90s");
    expect(fmtChipLabel(180)).toBe("3 min");
  });

  it("falls back to a mixed label for an odd custom duration", () => {
    expect(fmtChipLabel(150)).toBe("2m 30s");
  });
});

describe("capitalize", () => {
  it("uppercases only the first character", () => {
    expect(capitalize("resets soon")).toBe("Resets soon");
    expect(capitalize("")).toBe("");
  });
});

describe("fmtResetsAt", () => {
  const now = Date.UTC(2026, 6, 7, 12, 0, 0);

  it("says 'any moment now' once past the reset time", () => {
    expect(fmtResetsAt(new Date(now - 1000).toISOString(), now)).toBe("resets any moment now");
  });

  it("says 'within the hour' for a near reset", () => {
    expect(fmtResetsAt(new Date(now + 30 * 60_000).toISOString(), now)).toBe("resets within the hour");
  });

  it("gives an hour estimate for a same-day reset", () => {
    expect(fmtResetsAt(new Date(now + 5 * 3_600_000).toISOString(), now)).toBe("resets in about 5 hours");
  });

  it("falls back to 'midnight UTC' for a far-off or malformed reset", () => {
    expect(fmtResetsAt(new Date(now + 23 * 3_600_000).toISOString(), now)).toBe("resets at midnight UTC");
    expect(fmtResetsAt("not-a-date", now)).toBe("resets soon");
  });
});
