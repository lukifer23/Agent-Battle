import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MatchRecord, SeriesRecord } from "../../shared.js";
import { DATABASE_FILE_NAME } from "../../version.js";
import { openDatabase } from "./db.js";
import { PersistenceRepository } from "./repository.js";
import { importV7Store, type ImportV7Result } from "./importV7.js";

export interface DurableLoadResult {
  matches: MatchRecord[];
  series: SeriesRecord[];
  migrated: boolean;
  quarantined: number;
  backupPath?: string;
  recoveryWarning?: string;
}

export interface DurableStoreOptions {
  /** Legacy JSON store path. Defaults to `<dataDir>/matches.json`. */
  legacyPath?: string;
  /** Import the legacy store even if the database already has records. */
  forceImport?: boolean;
}

/**
 * Durable local store backed by SQLite. `open()` creates the database, applies
 * the schema and imports a legacy JSON v7 store exactly once if the database is
 * empty. The repository remains the single transaction boundary; a match
 * checkpoint never rewrites the archive.
 */
export class DurableStore {
  private importResult?: ImportV7Result;

  private constructor(readonly database: DatabaseSync, readonly repository: PersistenceRepository, readonly databasePath: string) {}

  static open(dataDir: string, options: DurableStoreOptions = {}): DurableStore {
    const databasePath = join(dataDir, DATABASE_FILE_NAME);
    const legacyPath = options.legacyPath ?? join(dataDir, "matches.json");
    const database = openDatabase(databasePath);
    const repository = new PersistenceRepository(database, databasePath);
    const store = new DurableStore(database, repository, databasePath);
    if ((options.forceImport || !repository.hasMatches()) && existsSync(legacyPath)) {
      store.importResult = importV7Store(repository, legacyPath);
    }
    return store;
  }

  load(): DurableLoadResult {
    const { matches, series } = this.repository.loadAll();
    const imported = this.importResult;
    if (imported) {
      const warning = imported.quarantined
        ? `${imported.quarantined} legacy record(s) were quarantined during import. Review the migration backup and the quarantine table.`
        : undefined;
      return { matches, series, migrated: true, quarantined: imported.quarantined, backupPath: imported.backupManifest, ...(warning ? { recoveryWarning: warning } : {}) };
    }
    return { matches, series, migrated: false, quarantined: 0 };
  }

  saveMatch(record: MatchRecord): void {
    this.repository.upsertMatch(record);
  }

  saveSeries(record: SeriesRecord): void {
    this.repository.upsertSeries(record);
  }

  deleteMatch(id: string): void {
    this.repository.deleteMatch(id);
  }

  close(): void {
    this.repository.close();
  }
}
