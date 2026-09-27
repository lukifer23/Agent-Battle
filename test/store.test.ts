import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { MatchStore, STORE_VERSION } from "../src/server/store.js";
import { validateMatchRecord } from "../src/server/schema.js";
import type { MatchRecord } from "../src/shared.js";

function sampleRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: "match-1",
    gameId: "chess",
    gameVersion: "standard-1",
    protocolVersion: "game-action-v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    revision: 0,
    players: [
      { id: "white", label: "White", agent: { provider: "codex", model: "", name: "Codex · CLI default" } },
      { id: "black", label: "Black", agent: { provider: "claude", model: "", name: "Claude Code · CLI default" } },
    ],
    settings: { turnTimeoutSeconds: 120, maxRetries: 1, retryPolicy: "retry-invalid-once-then-forfeit", promptVersion: "observation-contract-v2", toolSchemaVersion: "game-action-v1", resultPolicy: "engine-terminal-with-arena-adjudication", budgets: { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null } },
    gameState: { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", pgn: "", moves: [] },
    history: [],
    events: [],
    ...overrides,
  };
}

function tempStore(): { store: MatchStore; folder: string; path: string; cleanup: () => void } {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-store-"));
  const path = join(folder, "matches.json");
  return { store: new MatchStore(path), folder, path, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("a missing store loads as empty and saves a versioned envelope", () => {
  const { store, path, cleanup } = tempStore();
  try {
    assert.deepEqual(store.load(), { matches: [], migrated: false, quarantined: 0 });
    store.save([sampleRecord()]);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version: number; matches: unknown[] };
    assert.equal(parsed.version, STORE_VERSION);
    assert.equal(Array.isArray(parsed.matches), true);
    const loaded = store.load();
    assert.equal(loaded.migrated, false);
    assert.equal(loaded.matches.length, 1);
  } finally { cleanup(); }
});

test("a legacy array is migrated with a backup and keeps valid records", () => {
  const { store, path, cleanup } = tempStore();
  try {
    writeFileSync(path, JSON.stringify([sampleRecord({ id: "legacy" })]));
    const loaded = store.load();
    assert.equal(loaded.migrated, true);
    assert.equal(loaded.matches.length, 1);
    assert.equal(loaded.matches[0].id, "legacy");
    assert.ok(loaded.backupPath && existsSync(loaded.backupPath));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version: number };
    assert.equal(parsed.version, STORE_VERSION);
  } finally { cleanup(); }
});

test("invalid records are quarantined while valid records survive", () => {
  const { store, folder, path, cleanup } = tempStore();
  try {
    writeFileSync(path, JSON.stringify({ version: STORE_VERSION, matches: [sampleRecord({ id: "good" }), { id: "bad" }] }));
    const loaded = store.load();
    assert.equal(loaded.matches.length, 1);
    assert.equal(loaded.matches[0].id, "good");
    assert.equal(loaded.quarantined, 1);
    assert.ok(loaded.backupPath && existsSync(loaded.backupPath));
    const quarantine = readdirSync(folder).find((entry) => entry.includes(".quarantine-"));
    assert.ok(quarantine, "a quarantine file should be written");
    assert.match(readFileSync(join(folder, quarantine!), "utf8"), /bad/);
    assert.match(readFileSync(loaded.backupPath!, "utf8"), /good/);
  } finally { cleanup(); }
});

test("a corrupt root is preserved and never replaced silently", () => {
  const { store, folder, path, cleanup } = tempStore();
  try {
    writeFileSync(path, "{ not valid json");
    assert.throws(() => store.load(), /preserved/i);
    assert.equal(existsSync(path), false);
    const preservedName = readdirSync(folder).find((entry) => entry.startsWith(`${basename(path)}.unreadable-`));
    assert.ok(preservedName, "the unreadable store should be preserved");
    assert.equal(readFileSync(join(folder, preservedName!), "utf8"), "{ not valid json");
  } finally { cleanup(); }
});

test("a live lock blocks a second store owner and a stale lock is recovered", async () => {
  const { store, path, cleanup } = tempStore();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    writeFileSync(path, "[]");
    writeFileSync(`${path}.lock`, `${child.pid}\n`);
    const second = new MatchStore(path);
    assert.throws(() => second.acquireOwnership(), /already using/i);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    second.acquireOwnership();
    second.releaseOwnership();
    store.acquireOwnership();
    store.releaseOwnership();
  } finally {
    child.kill("SIGKILL");
    cleanup();
  }
});

test("record validation rejects inconsistent results and unknown winners", () => {
  assert.ok(validateMatchRecord(sampleRecord()).value);
  assert.match(validateMatchRecord(sampleRecord({ status: "finished" })).error ?? "", /no result/);
  assert.match(validateMatchRecord(sampleRecord({ status: "stopped", result: { kind: "win", winnerId: "white", notation: "1-0", reason: "x" } })).error ?? "", /must not have a result/);
  assert.match(validateMatchRecord(sampleRecord({ status: "finished", result: { kind: "win", winnerId: "nobody", notation: "1-0", reason: "x" } })).error ?? "", /not a participant/);
  assert.match(validateMatchRecord(sampleRecord({ status: "forfeit", result: { kind: "draw", notation: "1/2", reason: "x" } })).error ?? "", /must be a win/);
  assert.ok(validateMatchRecord(sampleRecord({ status: "finished", result: { kind: "win", winnerId: "white", notation: "1-0", reason: "x" } })).value);
});
