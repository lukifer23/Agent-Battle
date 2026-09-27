import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MatchRecord } from "../shared.js";

export class MatchStore {
  constructor(private readonly storePath: string) {}

  load(): MatchRecord[] {
    if (!existsSync(this.storePath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.storePath, "utf8"));
      return Array.isArray(parsed) ? (parsed as MatchRecord[]) : [];
    } catch (error) {
      throw new Error(`Could not read saved matches at ${this.storePath}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  }

  save(matches: MatchRecord[]): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const temporaryPath = `${this.storePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(matches, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.storePath);
  }
}

const defaultStore = new MatchStore(join(process.cwd(), "data", "matches.json"));
export const loadMatches = () => defaultStore.load();
export const saveMatches = (matches: MatchRecord[]) => defaultStore.save(matches);
