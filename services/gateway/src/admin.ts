/**
 * Admin API — mounted on both listeners; app.ts's admin-surface gate 403s
 * every /api/admin/* request on the public listener before any of this runs,
 * so nothing here re-checks surface or session (tailnet is the identity).
 * Mutating routes still go through the global CSRF origin check (app.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  DEFAULT_PUBLISHED_PRESET,
  QUOTA_CATEGORIES,
  type AdminHealth,
  type AdminUser,
  type AdminUserSummary,
  type GlobalSettings,
  type InviteCode,
  type PublishedPreset,
  type QuotaCategory,
  type UsageCategory,
  type UsageEvent,
  type UsageProvider,
  type UsageRollupRow,
} from "@wizz/contracts";
import { hashPassword } from "./auth";
import type { Vars } from "./context";
import { isUniqueConstraintError, type PresetCache, type SettingsCache } from "./db";
import { WizzError } from "./errors";
import { generateTempPassword, newId, newInviteCode } from "./crypto-ids";
import { applyQuotaOverridesPatch, utcMidnightISO, type QuotaOverridesPatch } from "./quota";
import { parseJsonBody } from "./request-utils";
import {
  getUserRowById,
  isSyntheticAdmin,
  mapUserRow,
  searchUsers,
  updateUserDisabled,
  updateUserPasswordHash,
  updateUserQuotaOverrides,
  type UserRow,
} from "./users";

export interface AdminDeps {
  db: Database.Database;
  settings: SettingsCache;
  presets: PresetCache;
}

/* ─────────────────────────── health ─────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(HERE, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PACKAGE_VERSION = readPackageVersion();

function buildHealth(db: Database.Database, settings: SettingsCache): AdminHealth {
  let ok = true;
  let users = 0;
  let usageEvents = 0;
  let sizeBytes = 0;
  try {
    users = (db.prepare("SELECT COUNT(*) as n FROM users").get() as { n: number }).n;
    usageEvents = (db.prepare("SELECT COUNT(*) as n FROM usage_events").get() as { n: number }).n;
    const pageCount = db.pragma("page_count", { simple: true }) as number;
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    sizeBytes = pageCount * pageSize;
  } catch {
    ok = false;
  }
  return {
    ok,
    version: process.env.WIZZ_BUILD_VERSION || PACKAGE_VERSION,
    uptimeS: Math.round(process.uptime()),
    db: { ok, sizeBytes, users, usageEvents },
    killSwitch: settings.get().killSwitch,
  };
}

/* ─────────────────────────── users ─────────────────────────── */

interface RawUserRollup {
  todayDirectorTokens: number;
  totalDirectorTokens: number;
  todayCloudCaptionFrames: number;
  totalCloudCaptionFrames: number;
  todaySttSeconds: number;
  totalSttSeconds: number;
  todaySunoGens: number;
  totalSunoGens: number;
  knownCostUSD: number | null;
  events: number;
}

function userUsageRollupStatement(db: Database.Database): Database.Statement {
  // The outer COALESCE matters even though every CASE already has an ELSE 0: SUM() over ZERO matching
  // rows (not zero-valued rows — no rows at all, e.g. a brand-new user) returns SQL NULL regardless of
  // the CASE branches, since there's nothing for the aggregate to fold over.
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN category = 'director' AND at >= @since THEN COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0) ELSE 0 END), 0) AS todayDirectorTokens,
      COALESCE(SUM(CASE WHEN category = 'director' THEN COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0) ELSE 0 END), 0) AS totalDirectorTokens,
      COALESCE(SUM(CASE WHEN category = 'caption' AND at >= @since THEN COALESCE(frames,0) ELSE 0 END), 0) AS todayCloudCaptionFrames,
      COALESCE(SUM(CASE WHEN category = 'caption' THEN COALESCE(frames,0) ELSE 0 END), 0) AS totalCloudCaptionFrames,
      COALESCE(SUM(CASE WHEN category = 'stt' AND at >= @since THEN COALESCE(seconds,0) ELSE 0 END), 0) AS todaySttSeconds,
      COALESCE(SUM(CASE WHEN category = 'stt' THEN COALESCE(seconds,0) ELSE 0 END), 0) AS totalSttSeconds,
      COALESCE(SUM(CASE WHEN category = 'music' AND at >= @since THEN COALESCE(units,0) ELSE 0 END), 0) AS todaySunoGens,
      COALESCE(SUM(CASE WHEN category = 'music' THEN COALESCE(units,0) ELSE 0 END), 0) AS totalSunoGens,
      SUM(actual_cost_usd) AS knownCostUSD,
      COUNT(*) AS events
    FROM usage_events WHERE user_id = @userId
  `);
}

function toUserUsage(row: RawUserRollup): AdminUserSummary["usage"] {
  return {
    today: {
      directorTokens: row.todayDirectorTokens,
      cloudCaptionFrames: row.todayCloudCaptionFrames,
      sttSeconds: row.todaySttSeconds,
      sunoGens: row.todaySunoGens,
    },
    total: {
      directorTokens: row.totalDirectorTokens,
      cloudCaptionFrames: row.totalCloudCaptionFrames,
      sttSeconds: row.totalSttSeconds,
      sunoGens: row.totalSunoGens,
    },
    knownCostUSD: row.knownCostUSD ?? 0,
    events: row.events,
  };
}

function toUserSummary(stmt: Database.Statement, row: UserRow): AdminUserSummary {
  const user = mapUserRow(row);
  const usageRow = stmt.get({ userId: user.id, since: utcMidnightISO() }) as RawUserRollup;
  return { ...user, usage: toUserUsage(usageRow) };
}

interface UsageEventRow {
  id: string;
  user_id: string;
  provider: string;
  category: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  frames: number | null;
  seconds: number | null;
  units: number | null;
  actual_cost_usd: number | null;
  upstream_status: number | null;
  at: string;
}

/** upstreamStatus is nullable in storage (a network error has no status) but non-null on the wire — 0 is the "no response at all" sentinel. */
function mapUsageEventRow(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider as UsageProvider,
    category: row.category as UsageCategory,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
    frames: row.frames,
    seconds: row.seconds,
    units: row.units,
    actualCostUSD: row.actual_cost_usd,
    upstreamStatus: row.upstream_status ?? 0,
    at: row.at,
  };
}

function validateQuotaOverridesPatch(patch: unknown): asserts patch is QuotaOverridesPatch {
  if (patch === null || patch === undefined) return;
  if (typeof patch !== "object") throw new WizzError("bad_request", "quotaOverrides must be an object or null.");
  for (const [key, value] of Object.entries(patch)) {
    if (!(QUOTA_CATEGORIES as readonly string[]).includes(key)) {
      throw new WizzError("bad_request", `Unknown quota category "${key}".`);
    }
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new WizzError("bad_request", `quotaOverrides.${key} must be a non-negative number or null.`);
    }
  }
}

function registerUserRoutes(app: Hono<{ Variables: Vars }>, deps: AdminDeps): void {
  const { db } = deps;

  app.get("/api/admin/users", (c) => {
    const rows = searchUsers(db, c.req.query("q"));
    const stmt = userUsageRollupStatement(db);
    const users = rows.map((row) => toUserSummary(stmt, row));
    return c.json({ users } satisfies { users: AdminUserSummary[] }, 200);
  });

  app.get("/api/admin/users/:id", (c) => {
    const id = c.req.param("id");
    const row = getUserRowById(db, id);
    if (!row) throw new WizzError("not_found");
    const stmt = userUsageRollupStatement(db);
    const recentRows = db
      .prepare("SELECT * FROM usage_events WHERE user_id = ? ORDER BY at DESC LIMIT 100")
      .all(id) as UsageEventRow[];
    return c.json(
      {
        user: toUserSummary(stmt, row),
        recent: recentRows.map(mapUsageEventRow),
      } satisfies { user: AdminUserSummary; recent: UsageEvent[] },
      200,
    );
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const id = c.req.param("id");
    const row = getUserRowById(db, id);
    if (!row) throw new WizzError("not_found");

    const body = await parseJsonBody<{ disabled?: unknown; quotaOverrides?: unknown }>(c);
    if (!body) throw new WizzError("bad_request");

    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") throw new WizzError("bad_request", "disabled must be a boolean.");
      // The synthetic tailnet admin is deliberately included in listings (spend visibility) but can never
      // be disabled — the admin surface's identity must always resolve. quotaOverrides on it stay allowed
      // (capping the lab's own spend is legitimate).
      if (isSyntheticAdmin(id)) {
        throw new WizzError(
          "bad_request",
          "The synthetic tailnet admin cannot be disabled — it is the admin listener's identity.",
        );
      }
      updateUserDisabled(db, id, body.disabled);
    }

    if ("quotaOverrides" in body) {
      validateQuotaOverridesPatch(body.quotaOverrides);
      const current = mapUserRow(getUserRowById(db, id) ?? row).quotaOverrides;
      const merged = applyQuotaOverridesPatch(current, body.quotaOverrides as QuotaOverridesPatch);
      updateUserQuotaOverrides(db, id, merged);
    }

    const updated = mapUserRow(getUserRowById(db, id) ?? row);
    return c.json({ user: updated } satisfies { user: AdminUser }, 200);
  });

  app.post("/api/admin/users/:id/reset-password", async (c) => {
    const id = c.req.param("id");
    const row = getUserRowById(db, id);
    if (!row) throw new WizzError("not_found");
    if (isSyntheticAdmin(id)) {
      throw new WizzError(
        "bad_request",
        "The synthetic tailnet admin has no password — arriving on the tailnet listener is its identity.",
      );
    }
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    updateUserPasswordHash(db, id, passwordHash);
    return c.json({ tempPassword } satisfies { tempPassword: string }, 200);
  });
}

/* ─────────────────────────── invites ─────────────────────────── */

interface InviteRow {
  id: string;
  code: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  disabled: number;
  created_at: string;
  note: string | null;
}

function mapInviteRow(row: InviteRow): InviteCode {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    note: row.note,
  };
}

function getInviteRowById(db: Database.Database, id: string): InviteRow | undefined {
  return db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as InviteRow | undefined;
}

function registerInviteRoutes(app: Hono<{ Variables: Vars }>, deps: AdminDeps): void {
  const { db } = deps;

  app.get("/api/admin/invites", (c) => {
    const rows = db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as InviteRow[];
    return c.json({ invites: rows.map(mapInviteRow) } satisfies { invites: InviteCode[] }, 200);
  });

  app.post("/api/admin/invites", async (c) => {
    const body = await parseJsonBody<{ maxUses?: unknown; expiresAt?: unknown; note?: unknown }>(c);
    if (!body || typeof body.maxUses !== "number" || !Number.isInteger(body.maxUses) || body.maxUses < 1) {
      throw new WizzError("bad_request", "maxUses must be a positive integer.");
    }
    if (
      body.expiresAt !== undefined &&
      body.expiresAt !== null &&
      (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt)))
    ) {
      throw new WizzError("bad_request", "expiresAt must be an ISO date string or null.");
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      throw new WizzError("bad_request", "note must be a string or null.");
    }

    const id = newId();
    const now = new Date().toISOString();
    const maxUses = body.maxUses;
    const expiresAt = (body.expiresAt as string | null | undefined) ?? null;
    const note = (body.note as string | null | undefined) ?? null;

    let code = newInviteCode();
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        db.prepare(
          "INSERT INTO invites (id, code, max_uses, used_count, expires_at, disabled, created_at, note) " +
            "VALUES (?, ?, ?, 0, ?, 0, ?, ?)",
        ).run(id, code, maxUses, expiresAt, now, note);
        break;
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < MAX_ATTEMPTS) {
          code = newInviteCode();
          continue;
        }
        throw err;
      }
    }

    const created = getInviteRowById(db, id);
    if (!created) throw new WizzError("upstream_error", "Invite was not persisted.");
    return c.json({ invite: mapInviteRow(created) } satisfies { invite: InviteCode }, 200);
  });

  app.patch("/api/admin/invites/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getInviteRowById(db, id);
    if (!existing) throw new WizzError("not_found");
    const body = await parseJsonBody<{ disabled?: unknown }>(c);
    if (!body || typeof body.disabled !== "boolean") {
      throw new WizzError("bad_request", "disabled must be a boolean.");
    }
    db.prepare("UPDATE invites SET disabled = ? WHERE id = ?").run(body.disabled ? 1 : 0, id);
    const updated = getInviteRowById(db, id);
    if (!updated) throw new WizzError("not_found");
    return c.json({ invite: mapInviteRow(updated) } satisfies { invite: InviteCode }, 200);
  });
}

/* ─────────────────────────── usage rollup ─────────────────────────── */

const ROLLUP_DIMENSIONS = ["day", "user", "provider", "model", "category"] as const;
type RollupDimension = (typeof ROLLUP_DIMENSIONS)[number];

function isRollupDimension(value: string): value is RollupDimension {
  return (ROLLUP_DIMENSIONS as readonly string[]).includes(value);
}

const DIMENSION_SELECT: Record<RollupDimension, string> = {
  day: "substr(usage_events.at, 1, 10) AS day",
  user: "usage_events.user_id AS userId, users.email AS email",
  provider: "usage_events.provider AS provider",
  model: "usage_events.model AS model",
  category: "usage_events.category AS category",
};
const DIMENSION_GROUP: Record<RollupDimension, string> = {
  day: "substr(usage_events.at, 1, 10)",
  user: "usage_events.user_id",
  provider: "usage_events.provider",
  model: "usage_events.model",
  category: "usage_events.category",
};

function parseGroupBy(param: string | undefined): RollupDimension[] {
  if (!param) return [];
  const parts = param
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!isRollupDimension(p)) throw new WizzError("bad_request", `Unknown groupBy dimension "${p}".`);
  }
  return parts as RollupDimension[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

function parseDateRange(fromParam: string | undefined, toParam: string | undefined): { fromISO: string; toISO: string } {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = fromParam ?? defaultFrom;
  const to = toParam ?? defaultTo;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new WizzError("bad_request", "from/to must be YYYY-MM-DD.");
  }
  return { fromISO: `${from}T00:00:00.000Z`, toISO: `${to}T23:59:59.999Z` };
}

function buildUsageRollupQuery(dims: RollupDimension[]): string {
  const select = [
    ...dims.map((d) => DIMENSION_SELECT[d]),
    "COUNT(*) AS events",
    "SUM(COALESCE(prompt_tokens,0)) AS promptTokens",
    "SUM(COALESCE(completion_tokens,0)) AS completionTokens",
    "SUM(COALESCE(cached_tokens,0)) AS cachedTokens",
    "SUM(COALESCE(frames,0)) AS frames",
    "SUM(COALESCE(seconds,0)) AS seconds",
    "SUM(COALESCE(units,0)) AS units",
    "SUM(actual_cost_usd) AS knownCostUSD", // SQL SUM over an all-NULL group is NULL — exactly "null when none did"
    "COUNT(actual_cost_usd) AS costedEvents", // COUNT(col) ignores NULLs — exactly "how many carried a cost"
  ].join(", ");
  const groupCols = dims.map((d) => DIMENSION_GROUP[d]);
  const groupBy = groupCols.length > 0 ? `GROUP BY ${groupCols.join(", ")}` : "";
  const orderBy = groupCols.length > 0 ? `ORDER BY ${groupCols.join(", ")}` : "";
  return `
    SELECT ${select}
    FROM usage_events
    LEFT JOIN users ON users.id = usage_events.user_id
    WHERE usage_events.at >= @from AND usage_events.at <= @to
    ${groupBy}
    ${orderBy}
  `;
}

function registerUsageRoutes(app: Hono<{ Variables: Vars }>, deps: AdminDeps): void {
  const { db } = deps;

  app.get("/api/admin/usage", (c) => {
    const dims = parseGroupBy(c.req.query("groupBy"));
    const { fromISO, toISO } = parseDateRange(c.req.query("from"), c.req.query("to"));
    const rows = db.prepare(buildUsageRollupQuery(dims)).all({ from: fromISO, to: toISO }) as UsageRollupRow[];
    return c.json({ rows } satisfies { rows: UsageRollupRow[] }, 200);
  });

  app.get("/api/admin/telemetry", (c) => {
    const { fromISO, toISO } = parseDateRange(c.req.query("from"), c.req.query("to"));
    const userId = c.req.query("userId");
    const params: Record<string, unknown> = { from: fromISO, to: toISO };
    let sql = `
      SELECT substr(telemetry_events.at, 1, 10) AS day, telemetry_events.user_id AS userId,
             users.email AS email, telemetry_events.type AS type, COUNT(*) AS count
      FROM telemetry_events
      LEFT JOIN users ON users.id = telemetry_events.user_id
      WHERE telemetry_events.at >= @from AND telemetry_events.at <= @to
    `;
    if (userId) {
      sql += " AND telemetry_events.user_id = @userId";
      params.userId = userId;
    }
    sql += " GROUP BY day, telemetry_events.user_id, telemetry_events.type ORDER BY day DESC";
    const rows = db.prepare(sql).all(params);
    return c.json({ rows }, 200);
  });
}

/* ─────────────────────────── settings ─────────────────────────── */

function validateGlobalSettingsShape(body: unknown): GlobalSettings {
  if (!body || typeof body !== "object") throw new WizzError("bad_request", "Body must be an object.");
  const b = body as Partial<GlobalSettings>;

  if (typeof b.killSwitch !== "boolean") throw new WizzError("bad_request", "killSwitch must be a boolean.");
  if (typeof b.inviteRequired !== "boolean") throw new WizzError("bad_request", "inviteRequired must be a boolean.");
  if (b.activePresetId !== null && typeof b.activePresetId !== "string") {
    throw new WizzError("bad_request", "activePresetId must be a string or null.");
  }
  if (
    !b.footageCap ||
    typeof b.footageCap.maxClips !== "number" ||
    typeof b.footageCap.maxTotalSeconds !== "number" ||
    b.footageCap.maxClips <= 0 ||
    b.footageCap.maxTotalSeconds <= 0
  ) {
    throw new WizzError("bad_request", "footageCap must be {maxClips, maxTotalSeconds} with positive values.");
  }
  if (!b.defaultQuotas || typeof b.defaultQuotas !== "object") {
    throw new WizzError("bad_request", "defaultQuotas is required.");
  }
  const rawQuotas = b.defaultQuotas as Record<string, unknown>;
  const defaultQuotas = {} as Record<QuotaCategory, number | null>;
  for (const category of QUOTA_CATEGORIES) {
    const value = rawQuotas[category];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new WizzError("bad_request", `defaultQuotas.${category} must be a non-negative number or null.`);
    }
    defaultQuotas[category] = value === null ? null : value;
  }

  return {
    killSwitch: b.killSwitch,
    inviteRequired: b.inviteRequired,
    activePresetId: b.activePresetId ?? null,
    footageCap: { maxClips: b.footageCap.maxClips, maxTotalSeconds: b.footageCap.maxTotalSeconds },
    defaultQuotas,
  };
}

function registerSettingsRoutes(app: Hono<{ Variables: Vars }>, deps: AdminDeps): void {
  const { db, settings, presets } = deps;

  app.get("/api/admin/settings", (c) => c.json(settings.get() satisfies GlobalSettings, 200));

  app.put("/api/admin/settings", async (c) => {
    const body = await parseJsonBody<unknown>(c);
    const validated = validateGlobalSettingsShape(body);
    if (validated.activePresetId) {
      const exists = db.prepare("SELECT 1 FROM presets WHERE id = ?").get(validated.activePresetId);
      if (!exists) throw new WizzError("bad_request", "activePresetId does not reference an existing preset.");
    }
    settings.set(validated);
    presets.invalidate(); // activePresetId may have changed
    return c.json(validated satisfies GlobalSettings, 200);
  });
}

/* ─────────────────────────── presets ─────────────────────────── */

type EditablePresetFields = Omit<PublishedPreset, "id" | "version" | "publishedAt">;

/** Shallow merge over `base` — every field optional in the request body, unset fields keep the base's value. labSettings is opaque (contracts §0) and passed through unvalidated. */
function mergePresetFields(body: Partial<PublishedPreset>, base: PublishedPreset): EditablePresetFields {
  const name = typeof body.name === "string" && body.name.trim() ? body.name : base.name;
  const styleWhitelist =
    Array.isArray(body.styleWhitelist) && body.styleWhitelist.every((s) => typeof s === "string")
      ? body.styleWhitelist
      : base.styleWhitelist;
  const directorModel =
    typeof body.directorModel === "string" && body.directorModel ? body.directorModel : base.directorModel;
  const promptMode = body.promptMode === "full" || body.promptMode === "candidates" ? body.promptMode : base.promptMode;
  const transcriptSource =
    body.transcriptSource === "local" || body.transcriptSource === "cloud"
      ? body.transcriptSource
      : base.transcriptSource;
  const cloudSTTDefaultOn =
    typeof body.cloudSTTDefaultOn === "boolean" ? body.cloudSTTDefaultOn : base.cloudSTTDefaultOn;
  const cloudCaptionsEnabled =
    typeof body.cloudCaptionsEnabled === "boolean" ? body.cloudCaptionsEnabled : base.cloudCaptionsEnabled;
  const musicEnabled = typeof body.musicEnabled === "boolean" ? body.musicEnabled : base.musicEnabled;
  const targetDurationChoicesS =
    Array.isArray(body.targetDurationChoicesS) && body.targetDurationChoicesS.every((n) => typeof n === "number")
      ? body.targetDurationChoicesS
      : base.targetDurationChoicesS;
  const allowCustomDuration =
    typeof body.allowCustomDuration === "boolean" ? body.allowCustomDuration : base.allowCustomDuration;
  const minTargetDurationS =
    typeof body.minTargetDurationS === "number" ? body.minTargetDurationS : base.minTargetDurationS;
  const maxTargetDurationS =
    typeof body.maxTargetDurationS === "number" ? body.maxTargetDurationS : base.maxTargetDurationS;

  if (minTargetDurationS <= 0 || maxTargetDurationS < minTargetDurationS) {
    throw new WizzError("bad_request", "minTargetDurationS/maxTargetDurationS are invalid.");
  }

  const labSettings = "labSettings" in body ? body.labSettings : base.labSettings;

  return {
    name,
    styleWhitelist,
    directorModel,
    promptMode,
    transcriptSource,
    cloudSTTDefaultOn,
    cloudCaptionsEnabled,
    musicEnabled,
    targetDurationChoicesS,
    allowCustomDuration,
    minTargetDurationS,
    maxTargetDurationS,
    labSettings,
  };
}

function registerPresetRoutes(app: Hono<{ Variables: Vars }>, deps: AdminDeps): void {
  const { db, settings, presets } = deps;

  app.get("/api/admin/presets", (c) => {
    const rows = db.prepare("SELECT json FROM presets ORDER BY created_at DESC").all() as { json: string }[];
    return c.json(
      { presets: rows.map((r) => JSON.parse(r.json) as PublishedPreset) } satisfies { presets: PublishedPreset[] },
      200,
    );
  });

  app.post("/api/admin/presets", async (c) => {
    const body = (await parseJsonBody<Partial<PublishedPreset>>(c)) ?? {};
    const fields = mergePresetFields(body, DEFAULT_PUBLISHED_PRESET);
    const id = newId();
    const now = new Date().toISOString();
    const preset: PublishedPreset = { id, version: 1, publishedAt: null, ...fields };
    db.prepare(
      "INSERT INTO presets (id, name, version, active, published_at, created_at, json) VALUES (?, ?, 1, 0, NULL, ?, ?)",
    ).run(id, preset.name, now, JSON.stringify(preset));
    return c.json({ preset } satisfies { preset: PublishedPreset }, 200);
  });

  app.put("/api/admin/presets/:id", async (c) => {
    const id = c.req.param("id");
    const existingRow = db.prepare("SELECT json FROM presets WHERE id = ?").get(id) as { json: string } | undefined;
    if (!existingRow) throw new WizzError("not_found");
    const existing = JSON.parse(existingRow.json) as PublishedPreset;

    const body = (await parseJsonBody<Partial<PublishedPreset>>(c)) ?? {};
    const fields = mergePresetFields(body, existing);
    const version = existing.version + 1;
    const preset: PublishedPreset = { id, version, publishedAt: existing.publishedAt, ...fields };

    db.prepare("UPDATE presets SET name = ?, version = ?, json = ? WHERE id = ?").run(
      preset.name,
      version,
      JSON.stringify(preset),
      id,
    );
    presets.invalidate(); // this id may be the active one
    return c.json({ preset } satisfies { preset: PublishedPreset }, 200);
  });

  app.post("/api/admin/presets/:id/activate", (c) => {
    const id = c.req.param("id");
    const row = db.prepare("SELECT json FROM presets WHERE id = ?").get(id) as { json: string } | undefined;
    if (!row) throw new WizzError("not_found");

    const now = new Date().toISOString();
    // The json blob's own publishedAt must be updated alongside the published_at COLUMN — otherwise a
    // later read straight from the blob (PresetCache, GET /api/admin/presets) would show a stale value
    // even though this response and the column both say "just published".
    const preset: PublishedPreset = { ...(JSON.parse(row.json) as PublishedPreset), publishedAt: now };

    const activate = db.transaction(() => {
      db.prepare("UPDATE presets SET active = 0").run();
      db.prepare("UPDATE presets SET active = 1, published_at = ?, json = ? WHERE id = ?").run(
        now,
        JSON.stringify(preset),
        id,
      );
    });
    activate();

    settings.set({ ...settings.get(), activePresetId: id });
    presets.invalidate();

    return c.json({ preset } satisfies { preset: PublishedPreset }, 200);
  });
}

/* ─────────────────────────── registration ─────────────────────────── */

export function registerAdminRoutes(app: Hono<{ Variables: Vars }>, deps: AdminDeps): void {
  app.get("/api/admin/health", (c) => c.json(buildHealth(deps.db, deps.settings) satisfies AdminHealth, 200));
  registerUserRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerUsageRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerPresetRoutes(app, deps);
}
