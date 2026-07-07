import { describe, expect, it } from "vitest";
import type { QuotaLimits } from "@wizz/contracts";
import {
  buildQuotaOverridesPatch,
  draftFromOverrides,
  draftToQuotaLimits,
  quotaLimitsToDraft,
  type QuotaOverrideDraft,
} from "./quota-drafts";

const ALL_UNSET: QuotaOverrideDraft = draftFromOverrides(null);

describe("draftFromOverrides", () => {
  it("marks every category as not-overridden when there are no overrides", () => {
    const draft = draftFromOverrides(null);
    expect(draft.sttSeconds).toEqual({ overridden: false, unlimited: false, value: 0 });
    expect(draft.directorTokens.overridden).toBe(false);
  });

  it("marks a present numeric override as overridden + not unlimited", () => {
    const draft = draftFromOverrides({ sttSeconds: 500 });
    expect(draft.sttSeconds).toEqual({ overridden: true, unlimited: false, value: 500 });
    expect(draft.sunoGens.overridden).toBe(false);
  });
});

describe("buildQuotaOverridesPatch", () => {
  it("returns undefined when the draft matches the baseline exactly (nothing to send)", () => {
    const draft = draftFromOverrides({ sttSeconds: 500 });
    expect(buildQuotaOverridesPatch({ sttSeconds: 500 }, draft)).toBeUndefined();
  });

  it("returns undefined for an untouched all-unset draft against a null baseline", () => {
    expect(buildQuotaOverridesPatch(null, ALL_UNSET)).toBeUndefined();
  });

  it("includes only the category that changed (sparse — matches the spec's PATCH example)", () => {
    const draft = draftFromOverrides(null);
    draft.sttSeconds = { overridden: true, unlimited: false, value: 500 };
    expect(buildQuotaOverridesPatch(null, draft)).toEqual({ sttSeconds: 500 });
  });

  it("accumulates a second override without disturbing the first", () => {
    let draft = draftFromOverrides({ sttSeconds: 500 });
    draft = { ...draft, sunoGens: { overridden: true, unlimited: false, value: 3 } };
    expect(buildQuotaOverridesPatch({ sttSeconds: 500 }, draft)).toEqual({ sunoGens: 3 });
  });

  it("clears a single overridden category by sending null when un-overridden", () => {
    const draft = draftFromOverrides({ sttSeconds: 500, sunoGens: 3 });
    draft.sttSeconds = { overridden: false, unlimited: false, value: 0 };
    expect(buildQuotaOverridesPatch({ sttSeconds: 500, sunoGens: 3 }, draft)).toEqual({ sttSeconds: null });
  });

  it("sends null for a category explicitly toggled to unlimited", () => {
    const draft = draftFromOverrides(null);
    draft.directorTokens = { overridden: true, unlimited: true, value: 0 };
    expect(buildQuotaOverridesPatch(null, draft)).toEqual({ directorTokens: null });
  });

  it("omits a category the admin never touched even when others changed", () => {
    const draft = draftFromOverrides({ cloudCaptionFrames: 10 });
    draft.sttSeconds = { overridden: true, unlimited: false, value: 500 };
    const patch = buildQuotaOverridesPatch({ cloudCaptionFrames: 10 }, draft);
    expect(patch).toEqual({ sttSeconds: 500 });
    expect(patch).not.toHaveProperty("cloudCaptionFrames");
  });

  it("changing the numeric value of an already-overridden category sends the new value", () => {
    const draft = draftFromOverrides({ sttSeconds: 500 });
    draft.sttSeconds.value = 900;
    expect(buildQuotaOverridesPatch({ sttSeconds: 500 }, draft)).toEqual({ sttSeconds: 900 });
  });
});

describe("quotaLimitsToDraft / draftToQuotaLimits round trip", () => {
  it("round-trips a mix of finite and unlimited categories", () => {
    const limits: QuotaLimits = {
      directorTokens: 40000,
      sunoGens: null,
      cloudCaptionFrames: 0,
      sttSeconds: 900,
    };
    expect(draftToQuotaLimits(quotaLimitsToDraft(limits))).toEqual(limits);
  });

  it("round-trips the all-unlimited default", () => {
    const limits: QuotaLimits = {
      directorTokens: null,
      sunoGens: null,
      cloudCaptionFrames: null,
      sttSeconds: null,
    };
    expect(draftToQuotaLimits(quotaLimitsToDraft(limits))).toEqual(limits);
  });
});
