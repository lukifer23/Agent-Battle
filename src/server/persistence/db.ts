import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DATABASE_SCHEMA_VERSION } from "../../version.js";

export interface OpenDatabaseOptions {
  /** When true, refuse to create a missing database file. */
  fileMustExist?: boolean;
}

/**
 * Opens (or creates) the durable SQLite database and applies the pragmas that
 * make it a safe local store:
 *
 * - `journal_mode = WAL` keeps writes append-only instead of rewriting the
 *   whole archive, which is the root cause this layer replaces.
 * - `synchronous = FULL` fsyncs the write-ahead log on every commit, preserving
 *   the current strong crash semantics (a committed checkpoint survives an app
 *   crash and a host power loss) without the O(archive) rewrite.
 * - `foreign_keys = ON` makes derived rows (participants, events) cascade with
 *   their match.
 * - `busy_timeout` gives a second local process a bounded wait instead of an
 *   immediate SQLITE_BUSY; the single-writer lock still prevents concurrent
 *   ownership in practice.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  if (options.fileMustExist && !existsSync(path)) throw new Error(`Database ${path} does not exist.`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  restrictPermissions(path);
  return db;
}

function restrictPermissions(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) chmodSync(candidate, 0o600);
    } catch { /* Permission tightening is best-effort; the directory should already be private. */ }
  }
}

export function readSchemaVersion(db: DatabaseSync): number | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  if (!row?.value) return undefined;
  const parsed = Number(row.value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function writeSchemaVersion(db: DatabaseSync, version = DATABASE_SCHEMA_VERSION): void {
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
}
