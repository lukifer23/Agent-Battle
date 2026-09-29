import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/server/persistence/index.js";
import { PersistenceRepository } from "../src/server/persistence/repository.js";
import { openDatabase } from "../src/server/persistence/db.js";
import { importV7Store } from "../src/server/persistence/importV7.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";
import { makeSeriesV2 } from "../src/server/series.js";
import type { MatchRecord } from "../src/shared.js";

const chess = new ChessGame();

function chessMatch(id: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id,
    gameId: "chess",
    gameVersion: "standard-1",
    protocolVersion: "game-action-v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    status: "ready",
    revision: 3,
    players: [
      { id: "white", label: "White", agent: { provider: "codex", model: "gpt-x", name: "Codex" } },
      { id: "black", label: "Black", agent: { provider: "claude", model: "claude-y", name: "Claude" } },
    ],
    settings: {
      turnTimeoutSeconds: 120,
      maxRetries: 1,
      retryPolicy: "retry-invalid-once-then-forfeit",
      promptVersion: "observation-contract-v3",
      toolSchemaVersion: "chess-action-v1",
      resultPolicy: "engine-terminal-with-arena-adjudication",
      budgets: { maxPlies: 250, maxRequests: 500, maxWallMinutes: 30, maxReportedCostUsd: null },
    },
    environment: { adapterVersion: "agent-battle/adapter-v6", promptVersion: "observation-contract-v3", toolSchemaVersion: "chess-action-v1", cliVersions: { codex: "1.0.0" } },
    gameState: chess.serialize(chess.createState()),
    history: [],
    events: [],
    ...overrides,
  };
}

function withEvents(record: MatchRecord, sequences: number[]): MatchRecord {
  return {
    ...record,
    events: sequences.map((sequence) => ({ at: "2026-01-01T00:00:00.000Z", type: "turn.started", text: `event ${sequence}`, sequence })),
  };
}

function tempDir(): string {
  return mkdtempSync(join(os.tmpdir(), "agent-battle-durable-"));
}

test("a match survives a lossless round trip through the durable repository", () => {
  const dir = tempDir();
  try {
    const store = DurableStore.open(dir);
    const record = withEvents(chessMatch("m-1"), [1, 2, 3]);
    record.series = { id: "s-1", slotId: "slot-1", attempt: 1 };
    store.saveMatch(record);
    const loaded = store.repository.getMatch("m-1");
    assert.deepEqual(loaded, record);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a series survives a lossless round trip with its slots and links", () => {
  const dir = tempDir();
  try {
    const store = DurableStore.open(dir);
    const series = makeSeriesV2(
      [{ provider: "claude", model: "model-a", name: "A" }, { provider: "claude", model: "model-b", name: "B" }],
      120,
      { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null },
      { mode: "exploratory", games: [{ gameId: "chess", gameVersion: "standard-1", repetitions: 2, rolePolicy: "alternating", challengePolicy: "fixed" }] },
      "11".repeat(32),
    );
    series.slots[0].matchIds.push("m-1");
    store.saveSeries(series);
    const loaded = store.repository.getSeries(series.id);
    assert.deepEqual(loaded, series);
    // The scheduler attempt index is backfilled from the slot linkage.
    const attempts = store.database.prepare("SELECT match_id, attempt_no FROM series_attempts WHERE series_id = ? ORDER BY attempt_no").all(series.id) as Array<{ match_id: string; attempt_no: number }>;
    assert.deepEqual(attempts.map((row) => ({ match_id: row.match_id, attempt_no: row.attempt_no })), [{ match_id: "m-1", attempt_no: 1 }]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a checkpoint cost is independent of the size of the archive", () => {
  const dir = tempDir();
  try {
    const database = openDatabase(join(dir, "bench.sqlite"));
    const repository = new PersistenceRepository(database, join(dir, "bench.sqlite"));
    for (let index = 0; index < 400; index += 1) repository.upsertMatch(chessMatch(`bulk-${index}`));
    const small = repository.getMatch("bulk-0")!;
    const start = performance.now();
    repository.upsertMatch({ ...small, revision: small.revision + 1 });
    const elapsed = performance.now() - start;
    // A single-record checkpoint must not scale with 400 archived records.
    assert.ok(elapsed < 50, `checkpoint took ${elapsed.toFixed(2)}ms`);
    assert.equal(repository.countMatches(), 400);
    repository.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("durable events are complete even when the record keeps a bounded window", () => {
  const dir = tempDir();
  try {
    const store = DurableStore.open(dir);
    // Simulate a rotated presentation window: only the last two events remain
    // on the record, but the durable log must retain the full sequence.
    for (const sequences of [[1, 2, 3, 4], [3, 4, 5, 6]]) store.saveMatch(withEvents(chessMatch("m-events"), sequences));
    const durable = store.repository.getMatchWithFullEvents("m-events")!;
    assert.deepEqual(durable.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
    // The record itself still reflects only the bounded window.
    assert.deepEqual(store.repository.getMatch("m-events")!.events.map((event) => event.sequence), [3, 4, 5, 6]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a legacy v7 store imports losslessly, backs up the original, and quarantines invalid records", () => {
  const dir = tempDir();
  try {
    const legacyPath = join(dir, "matches.json");
    const valid = chessMatch("legacy-1");
    const malformed = { ...chessMatch("legacy-2"), protocolVersion: "unsupported-protocol" };
    const series = makeSeriesV2(
      [{ provider: "claude", model: "model-a", name: "A" }, { provider: "claude", model: "model-b", name: "B" }],
      120,
      { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null },
      { mode: "exploratory", games: [{ gameId: "chess", gameVersion: "standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" }] },
      "22".repeat(32),
    );
    writeFileSync(legacyPath, JSON.stringify({ version: 7, matches: [valid, malformed], series: [series] }, null, 2));
    const originalHash = createHash("sha256").update(readFileSync(legacyPath)).digest("hex");

    const store = DurableStore.open(dir);
    const result = store.load();
    assert.equal(result.migrated, true);
    assert.equal(result.quarantined, 1);
    assert.equal(store.repository.countMatches(), 1);
    assert.equal(store.repository.countSeries(), 1);
    assert.equal(store.repository.getMatch("legacy-1")!.id, "legacy-1");
    assert.equal(store.repository.countQuarantine(), 1);
    assert.ok(result.backupPath && existsSync(result.backupPath));
    // The original legacy file is preserved byte-for-byte.
    assert.equal(createHash("sha256").update(readFileSync(legacyPath)).digest("hex"), originalHash);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unsupported future legacy store is refused without creating any records", () => {
  const dir = tempDir();
  try {
    const legacyPath = join(dir, "matches.json");
    writeFileSync(legacyPath, JSON.stringify({ version: 99, matches: [], series: [] }));
    assert.throws(() => DurableStore.open(dir), /Unsupported store version/);
    const databasePath = join(dir, "agent-battle.sqlite");
    if (existsSync(databasePath)) {
      const check = openDatabase(databasePath);
      const repository = new PersistenceRepository(check, databasePath);
      assert.equal(repository.countMatches(), 0);
      repository.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("data persists across a close and reopen (WAL durability)", () => {
  const dir = tempDir();
  try {
    const first = DurableStore.open(dir);
    first.saveMatch(chessMatch("persisted"));
    first.close();
    const second = DurableStore.open(dir);
    assert.equal(second.repository.getMatch("persisted")!.id, "persisted");
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed transaction rolls back every write in the batch", () => {
  const dir = tempDir();
  try {
    const store = DurableStore.open(dir);
    assert.throws(() => store.repository.transaction(() => {
      store.repository.upsertMatch(chessMatch("rolled-back"));
      throw new Error("boom");
    }), /boom/);
    assert.equal(store.repository.getMatch("rolled-back"), undefined);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("indexed history queries filter by game, model, provider and status", () => {
  const dir = tempDir();
  try {
    const store = DurableStore.open(dir);
    store.saveMatch(chessMatch("h-1"));
    store.saveMatch({ ...chessMatch("h-2"), status: "stopped" });
    const byGame = store.repository.queryMatches({ gameId: "chess" });
    assert.equal(byGame.total, 2);
    const byModel = store.repository.queryMatches({ model: "gpt-x" });
    assert.equal(byModel.total, 2);
    const byProvider = store.repository.queryMatches({ provider: "claude" });
    assert.equal(byProvider.total, 2);
    const byStatus = store.repository.queryMatches({ status: "stopped" });
    assert.equal(byStatus.total, 1);
    assert.equal(byStatus.matches[0].id, "h-2");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an interrupted import rolls back atomically and preserves the legacy source", () => {
  const dir = tempDir();
  try {
    const legacyPath = join(dir, "matches.json");
    const series = makeSeriesV2(
      [{ provider: "claude", model: "model-a", name: "A" }, { provider: "claude", model: "model-b", name: "B" }],
      120, { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null },
      { mode: "exploratory", games: [{ gameId: "chess", gameVersion: "standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" }] }, "33".repeat(32),
    );
    writeFileSync(legacyPath, JSON.stringify({ version: 7, matches: [chessMatch("ok-1")], series: [series] }));
    const source = readFileSync(legacyPath, "utf8");

    const databasePath = join(dir, "agent-battle.sqlite");
    const db = openDatabase(databasePath);
    const repository = new PersistenceRepository(db, databasePath);
    // Simulate a write failure in the middle of the import transaction.
    const originalSeries = repository.upsertSeries.bind(repository);
    (repository as unknown as { upsertSeries: (record: unknown) => void }).upsertSeries = (record: unknown) => {
      if ((record as { id: string }).id === series.id) throw new Error("ENOSPC: no space left on device");
      originalSeries(record as never);
    };
    assert.throws(() => importV7Store(repository, legacyPath), /ENOSPC/);
    // The whole transaction rolled back: no match, no series, no quarantine row.
    assert.equal(repository.countMatches(), 0);
    assert.equal(repository.countSeries(), 0);
    assert.equal(repository.countQuarantine(), 0);
    // The legacy source is byte-for-byte intact.
    assert.equal(readFileSync(legacyPath, "utf8"), source);
    repository.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed checkpoint propagates and leaves the previous durable revision", () => {
  const dir = tempDir();
  try {
    const store = DurableStore.open(dir);
    store.saveMatch(chessMatch("v1"));
    const repository = store.repository;
    const original = repository.upsertMatch.bind(repository);
    (repository as unknown as { upsertMatch: (record: MatchRecord) => void }).upsertMatch = () => { throw new Error("ENOSPC: no space left on device"); };
    assert.throws(() => store.saveMatch({ ...chessMatch("v1"), revision: 99 }), /ENOSPC/);
    (repository as unknown as { upsertMatch: (record: MatchRecord) => void }).upsertMatch = original;
    assert.equal(repository.getMatch("v1")!.revision, 3);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("import is idempotent: a populated database is not re-imported", () => {
  const dir = tempDir();
  try {
    const legacyPath = join(dir, "matches.json");
    writeFileSync(legacyPath, JSON.stringify({ version: 7, matches: [chessMatch("first")], series: [] }));
    const first = DurableStore.open(dir);
    assert.equal(first.repository.countMatches(), 1);
    first.close();
    const second = DurableStore.open(dir);
    assert.equal(second.repository.countMatches(), 1);
    second.load();
    assert.equal(second.repository.countMatches(), 1);
    second.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the invocation ledger is unique per invocation id", () => {
  const dir = tempDir();
  try {
    const store = DurableStore.open(dir);
    const now = new Date().toISOString();
    store.repository.recordInvocation({ invocationId: "inv-1", matchId: "m", reservedAt: now, state: "reserved" });
    store.repository.recordInvocation({ invocationId: "inv-1", matchId: "m", reservedAt: now, state: "completed" });
    assert.equal(store.repository.getInvocation("inv-1")!.state, "completed");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function probe(port: number, options: { method?: string; path: string; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: { "content-type": "application/json", connection: "close" }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function waitForListening(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await probe(port, { path: "/api/state" })).status === 200) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not start");
}

test("a durable match survives a SIGKILL and reloads without duplication", async () => {
  const dir = tempDir();
  const { chmodSync, mkdirSync } = await import("node:fs");
  const bin = join(dir, "bin"); mkdirSync(bin);
  const fixture = join(bin, "codex");
  writeFileSync(fixture, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex fixture 1'); process.exit(0); }\nprocess.exit(0);`);
  chmodSync(fixture, 0o700);
  const projectRoot = process.cwd();
  const tsxBin = join(projectRoot, "node_modules", ".bin", "tsx");
  const port = 7300 + Math.floor(Math.random() * 300);
  const env = { ...process.env, PORT: String(port), AGENT_BATTLE_DATA_DIR: dir, PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: "1" };
  const spawnServer = () => spawn(process.execPath, [tsxBin, "src/server/index.ts"], { cwd: projectRoot, env, stdio: ["ignore", "ignore", "ignore"] });
  try {
    const first = spawnServer();
    await waitForListening(first, port);
    const created = JSON.parse((await probe(port, { method: "POST", path: "/api/matches", body: JSON.stringify({
      gameId: "chess",
      players: { white: { provider: "codex", model: "durable-a" }, black: { provider: "codex", model: "durable-b" } },
      turnTimeoutSeconds: 30,
    }) })).body) as { match: { id: string } };
    const matchId = created.match.id;
    // Hard kill: no graceful shutdown checkpoint runs.
    await terminate(first, "SIGKILL");

    const second = spawnServer();
    try {
      await waitForListening(second, port);
      const list = JSON.parse((await probe(port, { path: "/api/matches" })).body) as { total: number; matches: Array<{ id: string; status: string }> };
      assert.equal(list.total, 1);
      assert.equal(list.matches[0].id, matchId);
      assert.equal(list.matches[0].status, "ready");
    } finally {
      await terminate(second, "SIGTERM");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Kills a child and resolves when it exits, tolerating an already-exited process. */
function terminate(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const done = () => resolve();
    child.once("exit", done);
    child.kill(signal);
    const fallback = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 8000);
    fallback.unref();
  });
}
