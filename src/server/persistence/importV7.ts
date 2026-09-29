import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MatchRecord, SeriesRecord } from "../../shared.js";
import { defaultGames } from "../../domain/defaultGames.js";
import { crossMatchInvocationErrors, validateSeriesLinkage } from "../integrity.js";
import { validateMatchRecord, validateSeriesRecord, validateStoreEnvelope } from "../schema.js";
import { restrictOwnerPermissions } from "./db.js";
import type { PersistenceRepository } from "./repository.js";

export interface ImportV7Result {
  importedMatches: number;
  importedSeries: number;
  quarantined: number;
  backupDir: string;
  backupManifest: string;
  sourceSha256: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function recordId(record: unknown): string | undefined {
  if (!record || typeof record !== "object" || !("id" in record)) return undefined;
  const id = (record as { id: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Copies every source file that belongs to the legacy store into an immutable
 * migration directory and records a SHA-256 manifest. The original files are
 * never modified or deleted, so a failed import always leaves a recovery path.
 */
function backupLegacyStore(storePath: string): { backupDir: string; backupManifest: string } {
  const directory = dirname(storePath);
  const backupDir = join(directory, "migrations", `v7-import-${stamp()}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const manifest: Record<string, string> = {};
  const baseName = storePath.slice(directory.length + 1);
  const related = existsSync(directory)
    ? readdirSync(directory).filter((name) => name === baseName || name.startsWith(`${baseName}.`))
    : [];
  for (const name of related) {
    const source = join(directory, name);
    try {
      const target = join(backupDir, name);
      copyFileSync(source, target);
      chmodSync(target, 0o600);
      manifest[name] = sha256File(source);
    } catch { /* A non-critical sibling, for example an open lock, is skipped. */ }
  }
  const backupManifest = join(backupDir, "manifest.json");
  writeFileSync(backupManifest, JSON.stringify({ storePath, sourceSha256: sha256File(storePath), copiedAt: new Date().toISOString(), files: manifest }, null, 2), { mode: 0o600 });
  chmodSync(backupManifest, 0o600);
  return { backupDir, backupManifest };
}

/**
 * Imports a legacy JSON store (bare array or versioned envelope up to v7) into
 * the durable database in one transaction. Invalid records and relationally
 * inconsistent series are quarantined. A structural failure refuses without
 * writing the receipt. The original file is never modified.
 */
export function importV7Store(repository: PersistenceRepository, storePath: string): ImportV7Result {
  if (!existsSync(storePath)) throw new Error(`No legacy store exists at ${storePath}.`);
  const text = readFileSync(storePath, "utf8");
  let root: unknown;
  try { root = JSON.parse(text); }
  catch { throw new Error(`Legacy store ${storePath} is not valid JSON. The original is preserved.`); }
  const envelope = validateStoreEnvelope(root);
  const sourceSha256 = sha256File(storePath);
  const { backupDir, backupManifest } = backupLegacyStore(storePath);

  let matches: MatchRecord[] = [];
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
  const conflicts = crossMatchInvocationErrors(matches);
  if (conflicts.size > 0) {
    const kept: MatchRecord[] = [];
    for (const match of matches) {
      const error = conflicts.get(match.id);
      if (error) invalid.push({ error, record: match });
      else kept.push(match);
    }
    matches = kept;
  }

  const series: Array<{ raw: unknown; record: SeriesRecord }> = [];
  const seenSeries = new Set<string>();
  for (const raw of envelope.series) {
    try {
      const record = validateSeriesRecord(raw);
      if (seenSeries.has(record.id)) throw new Error("Duplicate series id.");
      seenSeries.add(record.id);
      series.push({ raw, record });
    } catch (error) {
      invalid.push({ error: error instanceof Error ? error.message : "Invalid series", record: raw });
    }
  }
  const accepted = new Map(matches.map((match) => [match.id, match]));
  const quarantinedIds = new Set(invalid.flatMap((entry) => { const id = recordId(entry.record); return id ? [id] : []; }));
  const keptSeries: SeriesRecord[] = [];
  for (const entry of series) {
    const linkage = validateSeriesLinkage(entry.record, accepted, quarantinedIds);
    if (linkage) invalid.push({ error: linkage, record: entry.raw });
    else keptSeries.push(entry.record);
  }

  const importedAt = new Date().toISOString();
  repository.transaction(() => {
    for (const match of matches) repository.upsertMatch(match);
    for (const record of keptSeries) repository.upsertSeries(record);
    for (const entry of invalid) repository.addQuarantine(storePath, entry.error, entry.record, recordId(entry.record));
    repository.recordLegacyImport({
      sourcePath: storePath,
      sourceSha256,
      storeVersion: envelope.version,
      state: "completed",
      manifestPath: backupManifest,
      importedAt,
      matchCount: matches.length,
      seriesCount: keptSeries.length,
      quarantined: invalid.length,
    });
    repository.setMeta("imported_from", storePath);
    repository.setMeta("imported_at", importedAt);
    repository.setMeta("import_manifest", backupManifest);
  });
  restrictOwnerPermissions(repository.path);

  return { importedMatches: matches.length, importedSeries: keptSeries.length, quarantined: invalid.length, backupDir, backupManifest, sourceSha256 };
}
