import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
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

test("a future store version is refused without changing its bytes", () => {
  const { store, path, cleanup } = tempStore();
  try {
    const original = JSON.stringify({ version: 999, matches: [sampleRecord()] });
    writeFileSync(path, original);
    assert.throws(() => store.load(), /unsupported|future|version/i);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally { cleanup(); }
});

test("attempt phase survives a current-version load", () => {
  const { store, cleanup } = tempStore();
  try {
    const record = sampleRecord({ pendingTurn: {
      turnId: "turn-1", turnIndex: 1, ply: 1, playerId: "white", startedAt: "2026-01-01T00:00:00.000Z",
      attempts: [{ attempt: 1, startedAt: "2026-01-01T00:00:00.000Z", status: "invalid", phase: "protocol", toolCalls: null, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } }],
    } });
    store.save([record]);
    assert.equal(store.load().matches[0].pendingTurn?.attempts[0].phase, "protocol");
  } finally { cleanup(); }
});

test("unsupported numeric versions and duplicate IDs preserve recoverable records", () => {
  const { store, path, cleanup } = tempStore();
  try {
    for (const version of [-1, 2.5, 999]) {
      const source = JSON.stringify({ version, matches: [sampleRecord()] });
      writeFileSync(path, source);
      assert.throws(() => store.load(), /version/i);
      assert.equal(readFileSync(path, "utf8"), source);
    }
    writeFileSync(path, JSON.stringify({ version: STORE_VERSION, matches: [sampleRecord(), sampleRecord()] }));
    const loaded = store.load();
    assert.equal(loaded.matches.length, 1);
    assert.equal(loaded.quarantined, 1);
    assert.match(loaded.recoveryWarning ?? "", /quarantined/i);
    assert.ok(loaded.backupPath && existsSync(loaded.backupPath));
  } finally { cleanup(); }
});

test("a fabricated finished result is quarantined before it reaches the controller", () => {
  const { store, path, cleanup } = tempStore();
  try {
    writeFileSync(path, JSON.stringify({ version: STORE_VERSION, matches: [
      sampleRecord({ id: "valid" }),
      sampleRecord({ id: "fabricated", status: "finished", result: { kind: "win", winnerId: "white", notation: "1-0", reason: "fabricated" } }),
    ] }));
    const loaded = store.load();
    assert.deepEqual(loaded.matches.map((record) => record.id), ["valid"]);
    assert.equal(loaded.quarantined, 1);
    assert.ok(loaded.backupPath && readFileSync(loaded.backupPath, "utf8").includes("fabricated"));
  } finally { cleanup(); }
});

test("malformed saved settings and unsupported protocol do not enter the usable store", () => {
  const base = sampleRecord();
  const malformed = { ...base, settings: { ...base.settings, budgets: { ...base.settings.budgets, maxRequests: 1.5 } } };
  assert.match(validateMatchRecord(malformed).error ?? "", /maxRequests/);
  assert.match(validateMatchRecord({ ...base, protocolVersion: "unknown" }).error ?? "", /protocol version/);
  assert.match(validateMatchRecord({ ...base, revision: -1 }).error ?? "", /revision/);
  assert.match(validateMatchRecord({ ...base, status: "forfeit", result: { kind: "win", winnerId: "white", notation: "1-0", reason: "x" } }).error ?? "", /evidence/);
});

test("two simultaneous store workers have exactly one owner", async () => {
  const { folder, path, cleanup } = tempStore();
  const gate = join(folder, "go");
  const workerPath = new URL("./fixtures/store-lock-worker.ts", import.meta.url).pathname;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, path, gate], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
  });
  try {
    const first = run();
    const second = run();
    writeFileSync(gate, "go");
    const outcomes = await Promise.all([first, second]);
    assert.deepEqual(outcomes.sort(), ["acquired", "blocked"]);
  } finally { cleanup(); }
});

test("a nonowner cannot release another store's lock", () => {
  const { store, path, cleanup } = tempStore();
  try {
    store.acquireOwnership();
    const other = new MatchStore(path);
    other.releaseOwnership();
    assert.ok(existsSync(`${path}.lock`));
    store.releaseOwnership();
    assert.equal(existsSync(`${path}.lock`), false);
  } finally { cleanup(); }
});

test("stale-lock recovery competition has one winner", async () => {
  const { folder, path, cleanup } = tempStore();
  const gate = join(folder, "go");
  writeFileSync(`${path}.lock`, "999999999\n");
  const workerPath = new URL("./fixtures/store-lock-worker.ts", import.meta.url).pathname;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, path, gate], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
  });
  try {
    const first = run();
    const second = run();
    writeFileSync(gate, "go");
    assert.deepEqual((await Promise.all([first, second])).sort(), ["acquired", "blocked"]);
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
  const { store, path, cleanup } = tempStore();
  try {
    writeFileSync(path, "{ not valid json");
    assert.throws(() => store.load(), /preserved/i);
    assert.equal(readFileSync(path, "utf8"), "{ not valid json");
    assert.throws(() => store.load(), /preserved/i);
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
