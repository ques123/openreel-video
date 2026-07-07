/**
 * SQLite bootstrap: open + pragmas, numbered-migration runner (user_version
 * tracked), settings seed, the one-time bootstrap invite, session GC, and the
 * two hot-path read caches (settings, active preset) that every proxy call
 * and every /api/preset /api/quota hit needs cheaply.
 *
 * Migration SQL lives on disk as real .sql files (not inlined TS strings) per
 * the contract's "numbered SQL in src/migrations/". Resolved via
 * import.meta.url so it works identically under `tsx` (src/migrations
 * sitting next to src/db.ts) and under the esbuild bundle (the build script
 * copies src/migrations/*.sql to dist/migrations/ after bundling — see
 * package.json's "build" script and the README).
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings, type PublishedPreset } from "@wizz/contracts";
import { newId, newInviteCode } from "./crypto-ids";
import {
  SYNTHETIC_ADMIN_EMAIL,
  SYNTHETIC_ADMIN_PASSWORD_SENTINEL,
  SYNTHETIC_ADMIN_USER_ID,
} from "./users";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "migrations");

interface PendingMigration {
  version: number;
  file: string;
  sql: string;
}

function pendingMigrations(db: Database.Database): PendingMigration[] {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const pending: PendingMigration[] = [];
  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match) continue; // ignore anything not following the numbered-prefix convention
    const version = Number.parseInt(match[1], 10);
    if (version > currentVersion) {
      pending.push({ version, file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") });
    }
  }
  pending.sort((a, b) => a.version - b.version);
  return pending;
}

function runMigrations(db: Database.Database): void {
  for (const { version, sql } of pendingMigrations(db)) {
    const apply = db.transaction(() => {
      db.exec(sql);
      // PRAGMA user_version doesn't accept bound parameters; `version` comes
      // only from our own numbered filenames (readdirSync), never user input.
      db.pragma(`user_version = ${version}`);
    });
    apply();
  }
}

function seedSettings(db: Database.Database): void {
  const row = db.prepare("SELECT 1 FROM settings WHERE id = 1").get();
  if (!row) {
    db.prepare("INSERT INTO settings (id, json) VALUES (1, ?)").run(
      JSON.stringify(DEFAULT_GLOBAL_SETTINGS),
    );
  }
}

/**
 * Seed data like settings, not a migration: idempotent on every open, so an
 * already-deployed DB (colossus) picks the row up on its next boot with no
 * schema-version bump. See SYNTHETIC_ADMIN_USER_ID in users.ts for what this
 * identity is for and why login as it is impossible.
 */
function seedSyntheticAdmin(db: Database.Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, email, password_hash, created_at, disabled, last_seen_at, invite_id, quota_overrides) " +
      "VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL)",
  ).run(
    SYNTHETIC_ADMIN_USER_ID,
    SYNTHETIC_ADMIN_EMAIL,
    SYNTHETIC_ADMIN_PASSWORD_SENTINEL,
    new Date().toISOString(),
  );
}

/** True for a UNIQUE-constraint violation (e.g. users.email) — callers map that to the contract's email_taken. */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** Opens the DB, sets pragmas, applies pending migrations, and seeds the settings singleton row + synthetic admin. Safe to call repeatedly. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  seedSettings(db);
  seedSyntheticAdmin(db);
  return db;
}

/**
 * First-boot convenience: when no REAL account exists yet (the synthetic
 * tailnet admin doesn't count — it's seeded on every open and can't log in),
 * guarantees exactly one invite exists and prints its code to stdout so the
 * admin can create the first account. Idempotent across restarts — if an
 * invite already exists (bootstrap or otherwise) while users is still empty,
 * it re-prints that code instead of minting a second one.
 */
export function ensureBootstrapInvite(db: Database.Database): void {
  const { n } = db
    .prepare("SELECT COUNT(*) as n FROM users WHERE id != ?")
    .get(SYNTHETIC_ADMIN_USER_ID) as { n: number };
  if (n > 0) return;

  const existing = db
    .prepare("SELECT code FROM invites ORDER BY created_at ASC LIMIT 1")
    .get() as { code: string } | undefined;
  if (existing) {
    console.log(`[wizz-gateway] no accounts yet — bootstrap invite still unused: ${existing.code}`);
    return;
  }

  const code = newInviteCode();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO invites (id, code, max_uses, used_count, expires_at, disabled, created_at, note) " +
      "VALUES (?, ?, 1, 0, NULL, 0, ?, ?)",
  ).run(newId(), code, now, "bootstrap — admin");
  console.log(`[wizz-gateway] first boot: created bootstrap invite code: ${code}`);
}

/** Hourly sweep of expired sessions (contracts §2). Runs once immediately, then on the interval; timer is unref'd. */
export function startSessionGc(db: Database.Database, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const sweep = (): void => {
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return timer;
}

/* ─────────────────────────── hot-path caches ─────────────────────────── */

/** In-memory cache over the single settings row; invalidated by whichever admin route writes it. */
export class SettingsCache {
  #cached: GlobalSettings | null = null;
  constructor(private readonly db: Database.Database) {}

  get(): GlobalSettings {
    if (this.#cached) return this.#cached;
    const row = this.db.prepare("SELECT json FROM settings WHERE id = 1").get() as
      | { json: string }
      | undefined;
    this.#cached = row ? (JSON.parse(row.json) as GlobalSettings) : DEFAULT_GLOBAL_SETTINGS;
    return this.#cached;
  }

  /** Persists and updates the cache atomically (no invalidate-then-reread race). */
  set(next: GlobalSettings): void {
    this.db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(next));
    this.#cached = next;
  }

  invalidate(): void {
    this.#cached = null;
  }
}

/** In-memory cache over whichever preset settings.activePresetId points at. */
export class PresetCache {
  #cached: PublishedPreset | null | undefined = undefined; // undefined = not yet resolved this generation

  constructor(
    private readonly db: Database.Database,
    private readonly settings: SettingsCache,
    private readonly fallback: PublishedPreset,
  ) {}

  getActive(): PublishedPreset {
    if (this.#cached !== undefined) return this.#cached ?? this.fallback;
    const id = this.settings.get().activePresetId;
    const row = id
      ? (this.db.prepare("SELECT json FROM presets WHERE id = ?").get(id) as
          | { json: string }
          | undefined)
      : undefined;
    this.#cached = row ? (JSON.parse(row.json) as PublishedPreset) : null;
    return this.#cached ?? this.fallback;
  }

  invalidate(): void {
    this.#cached = undefined;
  }
}
