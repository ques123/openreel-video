/**
 * Pure state-shaping helpers for the two quota-editing surfaces in the admin:
 * per-user overrides (Users detail panel, sparse — a category is either
 * absent (inherit the global default) or a finite number; see
 * services/gateway/src/quota.ts's `applyQuotaOverridesPatch` and its README
 * note "storage never holds an explicit null under a present key") and
 * GlobalSettings.defaultQuotas (System section, dense — every category
 * always has a value, number or null=unlimited).
 *
 * Both editors present each category as [number input] OR [unlimited
 * toggle], but the wire shapes differ (sparse Partial<QuotaLimits> patch vs
 * a full QuotaLimits object), hence two distinct helper families below.
 */
import { QUOTA_CATEGORIES, type QuotaCategory, type QuotaLimits } from "@wizz/contracts";

/* ───────────────────── per-user override editor (sparse) ───────────────────── */

export interface QuotaOverrideDraftState {
  /** Whether this category has an override configured at all (vs inheriting the global default). */
  overridden: boolean;
  /** Only meaningful when `overridden`: true = clears/sets-unlimited (wire value null), false = `value`. */
  unlimited: boolean;
  /** Only meaningful when `overridden && !unlimited`. */
  value: number;
}

export type QuotaOverrideDraft = Record<QuotaCategory, QuotaOverrideDraftState>;

/** Build the editor's starting draft from a loaded user's stored overrides. */
export function draftFromOverrides(overrides: Partial<QuotaLimits> | null | undefined): QuotaOverrideDraft {
  const draft = {} as QuotaOverrideDraft;
  for (const category of QUOTA_CATEGORIES) {
    const existing = overrides?.[category];
    draft[category] =
      existing === undefined
        ? { overridden: false, unlimited: false, value: 0 }
        : { overridden: true, unlimited: existing === null, value: existing ?? 0 };
  }
  return draft;
}

/** `undefined` = "not overridden" (omit from the patch unless clearing a prior override); `null` = unlimited; else the number. */
function resolvedDraftValue(state: QuotaOverrideDraftState): number | null | undefined {
  if (!state.overridden) return undefined;
  return state.unlimited ? null : state.value;
}

/**
 * Sparse merge-patch builder: diffs the editor's draft against the
 * last-known baseline (AdminUser.quotaOverrides) and returns ONLY the
 * categories that actually changed this session (contracts §2's sparse
 * map — the PATCH endpoint merges this over the stored overrides). Returns
 * `undefined` when nothing changed, so the caller can skip the request
 * entirely rather than PATCH an empty `{}`.
 */
export function buildQuotaOverridesPatch(
  baseline: Partial<QuotaLimits> | null | undefined,
  draft: QuotaOverrideDraft,
): Partial<QuotaLimits> | undefined {
  const patch: Partial<QuotaLimits> = {};
  for (const category of QUOTA_CATEGORIES) {
    const baselineValue = baseline?.[category]; // number | undefined — storage never holds an explicit null
    const draftValue = resolvedDraftValue(draft[category]);
    if (draftValue === undefined) {
      if (baselineValue !== undefined) patch[category] = null; // was overridden, admin cleared it back to "inherit"
      continue;
    }
    if (draftValue !== baselineValue) patch[category] = draftValue;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/* ───────────────────── global default-quota editor (dense) ───────────────────── */

export interface QuotaLimitDraftState {
  unlimited: boolean;
  /** Only meaningful when `!unlimited`. */
  value: number;
}

export type QuotaLimitsDraft = Record<QuotaCategory, QuotaLimitDraftState>;

/** GlobalSettings.defaultQuotas always has all four categories present (never sparse) — no baseline diffing needed, just a straight round trip. */
export function quotaLimitsToDraft(limits: QuotaLimits): QuotaLimitsDraft {
  const draft = {} as QuotaLimitsDraft;
  for (const category of QUOTA_CATEGORIES) {
    const v = limits[category];
    draft[category] = v === null ? { unlimited: true, value: 0 } : { unlimited: false, value: v };
  }
  return draft;
}

export function draftToQuotaLimits(draft: QuotaLimitsDraft): QuotaLimits {
  const limits = {} as QuotaLimits;
  for (const category of QUOTA_CATEGORIES) {
    limits[category] = draft[category].unlimited ? null : draft[category].value;
  }
  return limits;
}
