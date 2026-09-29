import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DATABASE_SCHEMA_VERSION } from "../../version.js";
import { applySchema, migrateV1ToV2 } from "./schema.js";

export interface OpenDatabaseOptions {
  /** When true, refuse to create a missing database file. */
  fileMustExist?: boolean;
}

/**
 * Opens the durable database without mutating a schema this build does not own.
 *
 * A missing file is created at the current schema. An existing file is probed
 * read-only first. Schema 1 is migrated forward. The current schema is opened
 * read-write. Any other version, including a newer one, is left byte-for-byte
 * untouched: the probe never enables WAL, so it does not create `-wal`/`-shm`.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const directory = dirname(path);
  if (!existsSync(path)) {
    if (options.fileMustExist) throw new Error(`Database ${path} does not exist.`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const created = new DatabaseSync(path);
    try {
      applyConnectionPragmas(created);
      created.exec("BEGIN IMMEDIATE");
      try {
        applySchema(created);
        writeSchemaVersion(created, DATABASE_SCHEMA_VERSION);
        created.exec("COMMIT");
      } catch (error) {
        try { created.exec("ROLLBACK"); } catch { /* The transaction may already be aborted. */ }
        throw error;
      }
      enableWal(created);
      restrictOwnerPermissions(path);
      return created;
    } catch (error) {
      try { created.close(); } catch { /* Closing a failed open is best-effort. */ }
      throw error;
    }
  }

  const version = probeSchemaVersion(path);
  if (version !== 1 && version !== DATABASE_SCHEMA_VERSION) {
    throw new Error(`The database schema version ${version ?? "missing"} is not supported by this build (${DATABASE_SCHEMA_VERSION}). The file was not modified.`);
  }

  const db = new DatabaseSync(path);
  try {
    applyConnectionPragmas(db);
    if (version === 1) migrateV1ToV2(db);
    applySchema(db);
    const ready = readSchemaVersion(db);
    if (ready !== DATABASE_SCHEMA_VERSION) {
      throw new Error(`Database schema version ${ready ?? "missing"} was not migrated to ${DATABASE_SCHEMA_VERSION}.`);
    }
    enableWal(db);
    restrictOwnerPermissions(path);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Closing a failed open is best-effort. */ }
    throw error;
  }
}

function probeSchemaVersion(path: string): number | undefined {
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(path, { readOnly: true });
    return readSchemaVersion(probe);
  } catch (error) {
    throw new Error(`Refusing to open ${path}: ${error instanceof Error ? error.message : "unreadable database"}. The file was not modified.`);
  } finally {
    try { probe?.close(); } catch { /* The probe is read-only. */ }
  }
}

function applyConnectionPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
}

function enableWal(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
}

/**
 * Owner-only modes for the database file, its WAL/SHM siblings when they
 * exist, and the parent directory. A failure is thrown. Files that SQLite has
 * not created yet are skipped; callers re-apply this after writes because
 * `-wal` and `-shm` appear after the first transaction.
 */
export function restrictOwnerPermissions(databasePath: string): void {
  const directory = dirname(databasePath);
  const failures: string[] = [];
  try { chmodSync(directory, 0o700); }
  catch (error) { failures.push(`${directory}: ${error instanceof Error ? error.message : "chmod failed"}`); }
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) chmodSync(candidate, 0o600);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : "chmod failed"}`);
    }
  }
  if (failures.length) throw new Error(`Could not enforce owner-only permissions: ${failures.join("; ")}`);
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
