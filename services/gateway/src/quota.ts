/**
 * Quota math: effective-limit resolution (override ?? default), the
 * sparse-merge-patch semantics for admin quota-override edits, UTC-midnight
 * windowing, and the "used today" SQL per category. Kept separate from
 * proxy.ts so both the proxy pre-check and GET /api/quota share one
 * implementation.
 *
 * "Used today" per contracts §3: SUM(<column for category>) FROM
 * usage_events WHERE user_id=? AND at>=<UTC midnight> AND category=?, where
 * category here is the USAGE category (director/caption/stt/music) whose
 * CATEGORY_QUOTA maps to the QuotaCategory being checked — e.g. a caption
 * call's prompt/completion tokens must NOT count against directorTokens.
 */
import type Database from "better-sqlite3";
import {
  CATEGORY_QUOTA,
  QUOTA_CATEGORIES,
  type GlobalSettings,
  type QuotaCategory,
  type QuotaLimits,
  type QuotaStatus,
  type UsageCategory,
} from "@wizz/contracts";

/* ─────────────────────────── UTC day windowing ─────────────────────────── */

export function utcMidnightISO(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

export function nextUtcMidnightISO(date: Date = new Date()): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  ).toISOString();
}

/* ─────────────────────────── effective limit ─────────────────────────── */

/** effective limit = user override ?? global default; null = unlimited (skip the check entirely). */
export function effectiveQuotaLimit(
  overrides: Partial<QuotaLimits> | null | undefined,
  defaults: QuotaLimits,
  category: QuotaCategory,
): number | null {
  return overrides?.[category] ?? defaults[category];
}

/* ──────────────────────── quotaOverrides merge-patch ──────────────────────── */

/** PATCH /api/admin/users/:id body shape for the quotaOverrides field (validated by admin.ts before this runs). */
export type QuotaOverridesPatch = Partial<Record<QuotaCategory, number | null>> | null | undefined;

/**
 * JSON-merge-patch semantics (contracts §2): the field omitted entirely ->
 * no change; a category's value = null -> clear just that category (falls
 * back to the default); the whole field = null -> clear every override.
 * Storage never holds an explicit null under a present key — clearing always
 * deletes the key — so effectiveQuotaLimit's `??` fallback is unambiguous.
 */
export function applyQuotaOverridesPatch(
  existing: Partial<QuotaLimits> | null,
  patch: QuotaOverridesPatch,
): Partial<QuotaLimits> | null {
  if (patch === undefined) return existing;
  if (patch === null) return null;
  const merged: Partial<QuotaLimits> = { ...(existing ?? {}) };
  for (const key of Object.keys(patch) as QuotaCategory[]) {
    const value = patch[key];
    if (value === null || value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/* ─────────────────────────── "used today" queries ─────────────────────────── */

const QUOTA_COLUMN: Record<QuotaCategory, { usageCategory: UsageCategory; expr: string }> = {
  directorTokens: {
    usageCategory: "director",
    expr: "COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)",
  },
  cloudCaptionFrames: { usageCategory: "caption", expr: "COALESCE(frames, 0)" },
  sttSeconds: { usageCategory: "stt", expr: "COALESCE(seconds, 0)" },
  sunoGens: { usageCategory: "music", expr: "COALESCE(units, 0)" },
};

/** Prepares one statement per quota category up front (the category/expr are our own constants, never interpolated user input). */
export class QuotaStore {
  #statements: Record<QuotaCategory, Database.Statement>;

  constructor(db: Database.Database) {
    const statements = {} as Record<QuotaCategory, Database.Statement>;
    for (const category of QUOTA_CATEGORIES) {
      const { usageCategory, expr } = QUOTA_COLUMN[category];
      statements[category] = db.prepare(
        `SELECT COALESCE(SUM(${expr}), 0) as used FROM usage_events ` +
          `WHERE user_id = ? AND category = '${usageCategory}' AND at >= ?`,
      );
    }
    this.#statements = statements;
  }

  usedSince(userId: string, category: QuotaCategory, sinceISO: string): number {
    const row = this.#statements[category].get(userId, sinceISO) as { used: number };
    return row.used;
  }
}

/** The usage category (director/caption/stt/music) a proxy call's category header maps to for quota purposes. */
export function quotaCategoryFor(usageCategory: UsageCategory): QuotaCategory {
  return CATEGORY_QUOTA[usageCategory];
}

/* ─────────────────────────── pre-check + status assembly ─────────────────────────── */

export interface QuotaPrecheckResult {
  ok: boolean;
  used: number;
  limit: number | null;
  resetsAt: string;
}

/**
 * The proxy's step-7 pre-check. `extraForThisCall` is 0 for every category
 * except caption, where the request's image-part count is known up front and
 * folded in so a single large batch can't slip through on a nearly-exhausted
 * budget (contracts §2: "reject if they alone would cross the limit").
 * Boundary rule (shared with the plain case): used(+extra) == limit rejects,
 * one-under passes.
 */
export function precheckQuota(
  quotaStore: QuotaStore,
  userId: string,
  category: QuotaCategory,
  effectiveLimit: number | null,
  extraForThisCall = 0,
  now: Date = new Date(),
): QuotaPrecheckResult {
  const resetsAt = nextUtcMidnightISO(now);
  const used = quotaStore.usedSince(userId, category, utcMidnightISO(now));
  const ok = effectiveLimit === null || used + extraForThisCall < effectiveLimit;
  return { ok, used, limit: effectiveLimit, resetsAt };
}

export function buildQuotaStatus(
  quotaStore: QuotaStore,
  settings: GlobalSettings,
  userId: string,
  userOverrides: Partial<QuotaLimits> | null,
  now: Date = new Date(),
): QuotaStatus {
  const since = utcMidnightISO(now);
  const resetsAt = nextUtcMidnightISO(now);
  const categories = {} as QuotaStatus["categories"];
  for (const category of QUOTA_CATEGORIES) {
    const limit = effectiveQuotaLimit(userOverrides, settings.defaultQuotas, category);
    const used = quotaStore.usedSince(userId, category, since);
    categories[category] = { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
  }
  return { categories, resetsAt, killSwitch: settings.killSwitch };
}
