import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MatchRecord, SeriesRecord } from "../../shared.js";
import { DATABASE_FILE_NAME } from "../../version.js";
import { openDatabase } from "./db.js";
import { sha256File, importV7Store, type ImportV7Result } from "./importV7.js";
import { PersistenceRepository, type SeriesSaveSide } from "./repository.js";

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
  /**
   * Import the legacy store even when a receipt already exists, but only into
   * a database that has no accepted matches and no series. A populated
   * database is never overlaid.
   */
  forceImport?: boolean;
}

/**
 * Durable local store backed by SQLite. `open()` creates the database at the
 * current schema. A legacy JSON store is imported once per source hash. The
 * same hash is skipped, including an empty or series-only source. A changed
 * source is not merged unless `forceImport` is set on an empty database.
 */
export class DurableStore {
  private importResult?: ImportV7Result;
  private legacyWarning?: string;

  private constructor(readonly database: DatabaseSync, readonly repository: PersistenceRepository, readonly databasePath: string) {}

  static open(dataDir: string, options: DurableStoreOptions = {}): DurableStore {
    const databasePath = join(dataDir, DATABASE_FILE_NAME);
    const legacyPath = options.legacyPath ?? join(dataDir, "matches.json");
    const database = openDatabase(databasePath);
    try {
      const repository = new PersistenceRepository(database, databasePath);
      const store = new DurableStore(database, repository, databasePath);
      store.reconcileLegacy(legacyPath, options.forceImport === true);
      return store;
    } catch (error) {
      try { database.close(); } catch { /* The failed open must not keep the file locked. */ }
      throw error;
    }
  }

  private reconcileLegacy(legacyPath: string, forceImport: boolean): void {
    this.backfillLegacyReceipt();
    if (!existsSync(legacyPath)) return;
    const hash = sha256File(legacyPath);
    const receipt = this.repository.getLegacyImport(legacyPath);
    const populated = this.repository.countMatches() > 0 || this.repository.countSeries() > 0;
    if (receipt?.state === "completed" && receipt.sourceSha256 === hash) return;
    if (receipt && receipt.sourceSha256 !== hash && !forceImport) {
      this.legacyWarning = "legacy source changed after import; automatic merge was refused.";
      return;
    }
    if (!receipt && populated && !forceImport) {
      this.legacyWarning = "legacy source changed after import; automatic merge was refused.";
      return;
    }
    if (populated) throw new Error("Refusing to import a legacy store over a database that already has matches or series.");
    this.importResult = importV7Store(this.repository, legacyPath);
  }

  /** Older databases recorded an import in meta before receipts existed. */
  private backfillLegacyReceipt(): void {
    const sourcePath = this.repository.getMeta("imported_from");
    if (!sourcePath || this.repository.getLegacyImport(sourcePath)) return;
    this.repository.recordLegacyImport({
      sourcePath,
      sourceSha256: existsSync(sourcePath) ? sha256File(sourcePath) : "absent",
      storeVersion: Number(this.repository.getMeta("imported_store_version") ?? 7),
      state: "completed",
      manifestPath: this.repository.getMeta("import_manifest") ?? "",
      importedAt: this.repository.getMeta("imported_at") ?? new Date().toISOString(),
      matchCount: this.repository.countMatches(),
      seriesCount: this.repository.countSeries(),
      quarantined: this.repository.countQuarantine(),
    });
  }

  load(): DurableLoadResult {
    const validated = this.repository.validateResident();
    const imported = this.importResult;
    const warnings = [
      imported?.quarantined ? `${imported.quarantined} legacy record(s) were quarantined during import. Review the migration backup and the quarantine table.` : undefined,
      this.legacyWarning,
      validated.warning,
    ].filter((warning): warning is string => Boolean(warning));
    return {
      matches: validated.matches,
      series: validated.series,
      migrated: Boolean(imported),
      quarantined: (imported?.quarantined ?? 0) + validated.quarantined,
      ...(imported ? { backupPath: imported.backupManifest } : {}),
      ...(warnings.length ? { recoveryWarning: warnings.join(" ") } : {}),
    };
  }

  saveMatch(record: MatchRecord): void {
    this.repository.upsertMatch(record);
  }

  saveSeries(record: SeriesRecord, side?: SeriesSaveSide): void {
    this.repository.upsertSeries(record, side);
  }

  deleteMatch(id: string): void {
    this.repository.deleteMatch(id);
  }

  close(): void {
    this.repository.close();
  }
}
