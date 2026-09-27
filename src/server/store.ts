import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MatchRecord } from "../shared.js";
import { validateMatchRecord, validateStoreEnvelope } from "./schema.js";

export const STORE_VERSION = 3;

export interface LoadResult {
  matches: MatchRecord[];
  migrated: boolean;
  quarantined: number;
  backupPath?: string;
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

  constructor(readonly storePath: string) {
    this.lockPath = `${storePath}.lock`;
  }

  acquireOwnership(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    if (existsSync(this.lockPath)) {
      const raw = readFileSync(this.lockPath, "utf8").trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid)) {
        throw new Error(`Another Agent Battle process (pid ${pid}) is already using ${this.storePath}. Stop it before starting a second instance.`);
      }
      rmSync(this.lockPath, { force: true });
    }
    writeFileSync(this.lockPath, `${process.pid}\n`, { mode: 0o600 });
    this.ownsLock = true;
  }

  releaseOwnership(): void {
    if (!this.ownsLock) return;
    try { rmSync(this.lockPath, { force: true }); }
    catch { /* The lock may already be gone. */ }
    this.ownsLock = false;
  }

  load(): LoadResult {
    if (!existsSync(this.storePath)) return { matches: [], migrated: false, quarantined: 0 };
    const text = readFileSync(this.storePath, "utf8");
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      const preserved = this.preserve(`unreadable-${stamp()}`);
      throw new Error(`Saved matches at ${this.storePath} are not valid JSON. The original was preserved at ${preserved}.`);
    }
    let envelope: { version: number; records: unknown[] };
    try {
      envelope = validateStoreEnvelope(root);
    } catch (error) {
      const preserved = this.preserve(`unexpected-root-${stamp()}`);
      throw new Error(`Saved matches at ${this.storePath} have an unexpected structure. The original was preserved at ${preserved}. ${error instanceof Error ? error.message : ""}`);
    }

    const matches: MatchRecord[] = [];
    const invalid: Array<{ error?: string; record: unknown }> = [];
    for (const record of envelope.records) {
      const result = validateMatchRecord(record);
      if (result.value) matches.push(result.value);
      else invalid.push({ error: result.error, record });
    }

    const needsMigration = envelope.version !== STORE_VERSION;
    if (!needsMigration && invalid.length === 0) return { matches, migrated: false, quarantined: 0 };

    const backupPath = this.backup(`pre-migration-${stamp()}`);
    if (invalid.length > 0) this.writeQuarantine(invalid);
    this.save(matches);
    return { matches, migrated: true, quarantined: invalid.length, backupPath };
  }

  save(matches: MatchRecord[]): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ version: STORE_VERSION, matches }, null, 2);
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

  private preserve(label: string): string {
    const target = `${this.storePath}.${label}.json`;
    try { renameSync(this.storePath, target); return target; }
    catch { return this.storePath; }
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
export const saveMatches = (matches: MatchRecord[]): void => defaultStore.save(matches);
