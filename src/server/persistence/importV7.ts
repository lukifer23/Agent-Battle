import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MatchRecord, SeriesRecord } from "../../shared.js";
import { defaultGames } from "../../domain/defaultGames.js";
import { validateMatchRecord, validateSeriesRecord, validateStoreEnvelope } from "../schema.js";
import type { PersistenceRepository } from "./repository.js";

export interface ImportV7Result {
  importedMatches: number;
  importedSeries: number;
  quarantined: number;
  backupDir: string;
  backupManifest: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Copies every source file that belongs to the legacy store into an immutable
 * migration directory and records a SHA-256 manifest. The original files are
 * never modified or deleted, so a failed import always leaves a recovery path.
 */
function backupLegacyStore(storePath: string): { backupDir: string; backupManifest: string } {
  const directory = dirname(storePath);
  const backupDir = join(directory, "migrations", `v7-import-${stamp()}`);
  mkdirSync(backupDir, { recursive: true });
  const manifest: Record<string, string> = {};
  const baseName = storePath.slice(directory.length + 1);
  const related = existsSync(directory)
    ? readdirSync(directory).filter((name) => name === baseName || name.startsWith(`${baseName}.`))
    : [];
  for (const name of related) {
    const source = join(directory, name);
    try {
      copyFileSync(source, join(backupDir, name));
      manifest[name] = sha256(source);
    } catch { /* Non-critical sibling (for example an open lock) is skipped. */ }
  }
  const backupManifest = join(backupDir, "manifest.json");
  writeFileSync(backupManifest, JSON.stringify({ storePath, copiedAt: new Date().toISOString(), files: manifest }, null, 2), { mode: 0o600 });
  return { backupDir, backupManifest };
}

/**
 * Imports a legacy JSON store (bare array or versioned envelope up to v7) into
 * the durable database in one transaction. Invalid records are quarantined
 * rather than allowed to abort the import; a structural failure (unreadable or
 * future version) refuses without writing anything.
 */
export function importV7Store(repository: PersistenceRepository, storePath: string): ImportV7Result {
  if (!existsSync(storePath)) throw new Error(`No legacy store exists at ${storePath}.`);
  const text = readFileSync(storePath, "utf8");
  let root: unknown;
  try { root = JSON.parse(text); }
  catch { throw new Error(`Legacy store ${storePath} is not valid JSON. The original is preserved.`); }
  const envelope = validateStoreEnvelope(root);

  const { backupDir, backupManifest } = backupLegacyStore(storePath);

  const matches: MatchRecord[] = [];
  const invalid: Array<{ error?: string; record: unknown }> = [];
  const seenIds = new Set<string>();
  for (const raw of envelope.records) {
    const result = validateMatchRecord(raw);
    const gameError = result.value ? defaultGames.validateRecord(result.value) : undefined;
    if (result.value && !gameError && !seenIds.has(result.value.id)) {
      seenIds.add(result.value.id);
      matches.push(result.value);
    } else if (gameError) invalid.push({ error: gameError, record: raw });
    else if (result.value) invalid.push({ error: `duplicate match id ${result.value.id}`, record: raw });
    else invalid.push({ error: result.error, record: raw });
  }

  const series: SeriesRecord[] = [];
  const seenSeries = new Set<string>();
  for (const raw of envelope.series) {
    try {
      const record = validateSeriesRecord(raw);
      if (seenSeries.has(record.id)) throw new Error("Duplicate series id.");
      seenSeries.add(record.id);
      series.push(record);
    } catch (error) {
      invalid.push({ error: error instanceof Error ? error.message : "Invalid series", record: raw });
    }
  }

  repository.transaction(() => {
    for (const match of matches) repository.upsertMatch(match);
    for (const record of series) repository.upsertSeries(record);
    for (const entry of invalid) repository.addQuarantine(storePath, entry.error, entry.record);
    repository.setMeta("imported_from", storePath);
    repository.setMeta("imported_at", new Date().toISOString());
    repository.setMeta("import_manifest", backupManifest);
  });

  return { importedMatches: matches.length, importedSeries: series.length, quarantined: invalid.length, backupDir, backupManifest };
}
