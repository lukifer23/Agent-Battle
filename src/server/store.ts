import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { MatchRecord, SeriesRecord } from "../shared.js";
import { defaultGames } from "../domain/defaultGames.js";
import { validateMatchRecord, validateSeriesRecord, validateStoreEnvelope } from "./schema.js";

export const STORE_VERSION = 6;

export interface LoadResult {
  matches: MatchRecord[];
  series: SeriesRecord[];
  migrated: boolean;
  quarantined: number;
  backupPath?: string;
  recoveryWarning?: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class MatchStore {
  private readonly lockPath: string;
  private ownsLock = false;
  private lockToken?: string;

  constructor(readonly storePath: string, private readonly validateGame: (record: MatchRecord) => string | undefined = (record) => defaultGames.validateRecord(record)) {
    this.lockPath = `${storePath}.lock`;
  }

  acquireOwnership(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    if (this.ownsLock) return;
    const token = randomUUID();
    const claim = (): boolean => {
      let fd: number;
      try { fd = openSync(this.lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
      finally { closeSync(fd); }
      this.lockToken = token;
      this.ownsLock = true;
      return true;
    };
    if (claim()) return;
    const recoveryGuard = `${this.lockPath}.recovery`;
    try { mkdirSync(recoveryGuard, { mode: 0o700 }); }
    catch {
      throw new Error(`Store ownership or stale-lock recovery is already in progress for ${this.storePath}. No data was loaded.`);
    }
    try {
      const raw = readFileSync(this.lockPath, "utf8").trim();
      let pid: number;
      try {
        const parsed: unknown = JSON.parse(raw);
        pid = typeof parsed === "object" && parsed !== null && "pid" in parsed ? Number(parsed.pid) : Number(raw);
      } catch { pid = Number(raw); }
      if (!Number.isSafeInteger(pid) || pid < 1 || isProcessAlive(pid)) {
        throw new Error(`Another Agent Battle process is already using ${this.storePath}, or the lock is uncertain. Stop it or inspect the lock before recovery.`);
      }
      rmSync(this.lockPath);
      if (!claim()) throw new Error(`Another Agent Battle process acquired ${this.storePath} during stale-lock recovery.`);
    } finally { rmdirSync(recoveryGuard); }
  }

  releaseOwnership(): void {
    if (!this.ownsLock) return;
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, "utf8")) as { token?: string };
      if (parsed.token === this.lockToken) rmSync(this.lockPath);
    }
    catch { /* The lock may already be gone. */ }
    this.ownsLock = false;
    this.lockToken = undefined;
  }

  load(): LoadResult {
    if (!existsSync(this.storePath)) return { matches: [], series: [], migrated: false, quarantined: 0 };
    const text = readFileSync(this.storePath, "utf8");
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      throw new Error(`Saved matches at ${this.storePath} are not valid JSON. The original was preserved in place; the server cannot start until it is repaired or restored.`);
    }
    let envelope: { version: number; records: unknown[]; series: unknown[] };
    try {
      envelope = validateStoreEnvelope(root);
    } catch (error) {
      throw new Error(`Saved matches at ${this.storePath} have an unsupported version or structure. The original was preserved in place. ${error instanceof Error ? error.message : ""}`);
    }

    const matches: MatchRecord[] = [];
    const invalid: Array<{ error?: string; record: unknown }> = [];
    const seenIds = new Set<string>();
    for (const record of envelope.records) {
      const result = validateMatchRecord(record);
      const gameError = result.value ? this.validateGame(result.value) : undefined;
      if (result.value && !gameError && !seenIds.has(result.value.id)) {
        seenIds.add(result.value.id);
        matches.push(result.value);
      }
      else if (gameError) invalid.push({ error: gameError, record });
      else if (result.value) invalid.push({ error: `duplicate match id ${result.value.id}`, record });
      else invalid.push({ error: result.error, record });
    }

    const series: SeriesRecord[] = [];
    const seenSeries = new Set<string>();
    for (const raw of envelope.series) {
      try {
        const record = validateSeriesRecord(raw);
        if (seenSeries.has(record.id)) throw new Error("Duplicate series id.");
        seenSeries.add(record.id);
        for (const slot of record.slots) for (const [attempt, matchId] of slot.matchIds.entries()) {
          const match = matches.find((candidate) => candidate.id === matchId);
          if (!match || match.series?.id !== record.id || match.series.slotId !== slot.id || match.series.attempt !== attempt + 1 || match.gameId !== slot.gameId) throw new Error("Series slot linkage differs from match record.");
          if (slot.gameId === "hangman" && (match.gameState as { provenance?: { seed?: string } }).provenance?.seed !== slot.challengeSeed) throw new Error("Match challenge differs from series seed.");
          for (const [role, agentIndex] of Object.entries(slot.roles)) {
            const actual = match.players.find((player) => player.id === role)?.agent;
            const expected = record.agents[agentIndex];
            if (!actual || !expected || actual.provider !== expected.provider || actual.model !== expected.model || (actual.reasoning ?? "") !== (expected.reasoning ?? "")) throw new Error("Series agent assignment differs from match.");
          }
        }
        if (record.status === "completed" && record.slots.some((slot) => !slot.skipped && !["finished", "forfeit"].includes(matches.find((match) => match.id === slot.matchIds.at(-1))?.status ?? ""))) throw new Error("Completed series has unfinished slots.");
        series.push(record);
      } catch (error) { invalid.push({ error: error instanceof Error ? error.message : "Invalid series", record: raw }); }
    }
    const needsMigration = envelope.version !== STORE_VERSION;
    if (!needsMigration && invalid.length === 0) return { matches, series, migrated: false, quarantined: 0 };

    const backupPath = this.backup(`pre-migration-${stamp()}`);
    if (invalid.length > 0) this.writeQuarantine(invalid);
    this.save(matches, series);
    return { matches, series, migrated: true, quarantined: invalid.length, backupPath,
      ...(invalid.length ? { recoveryWarning: `${invalid.length} saved match record(s) were quarantined. Review the backup and quarantine file.` } : {}) };
  }

  save(matches: MatchRecord[], series: SeriesRecord[] = []): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ version: STORE_VERSION, matches, series }, null, 2);
    const fd = openSync(temporaryPath, "w", 0o600);
    try {
      writeFileSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, this.storePath);
    this.fsyncDirectory(dirname(this.storePath));
  }

  private backup(label: string): string {
    const target = `${this.storePath}.${label}.bak`;
    copyFileSync(this.storePath, target);
    return target;
  }

  private writeQuarantine(entries: Array<{ error?: string; record: unknown }>): void {
    const target = `${this.storePath}.quarantine-${stamp()}.json`;
    writeFileSync(target, JSON.stringify({ quarantinedAt: new Date().toISOString(), entries }, null, 2), { mode: 0o600 });
  }

  private fsyncDirectory(directory: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(directory, "r");
      fsyncSync(fd);
    } catch { /* Directory fsync is not available on every platform. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

const dataDirectory = process.env.AGENT_BATTLE_DATA_DIR ?? join(process.cwd(), "data");
const defaultStore = new MatchStore(join(dataDirectory, "matches.json"));

export const acquireStoreOwnership = (): void => defaultStore.acquireOwnership();
export const releaseStoreOwnership = (): void => defaultStore.releaseOwnership();
export const loadMatches = (): LoadResult => defaultStore.load();
export const saveMatches = (matches: MatchRecord[], series: SeriesRecord[] = []): void => defaultStore.save(matches, series);
