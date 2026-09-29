import { buildSnapshot } from "../src/domain/snapshot.js";
import { projectRecord } from "../src/domain/projection.js";
import { MatchStore } from "../src/server/store.js";
import { DurableStore } from "../src/server/persistence/index.js";
import { BattleshipGame } from "../src/games/battleship/BattleshipGame.js";
import { makeSeriesV2 } from "../src/server/series.js";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { AgentAttempt, MatchEvent, MatchRecord, TurnTelemetry } from "../src/shared.js";

const turnTimeout = 120;

function attempt(index: number): AgentAttempt {
  return {
    attempt: index,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:02.000Z",
    latencyMs: 2000,
    status: "valid",
    action: { type: "move", payload: { move: "e2e4" } },
    responseExcerpt: "x".repeat(1200),
    stderrExcerpt: "y".repeat(700),
    toolCalls: 0,
    usage: { inputTokens: 1200, outputTokens: 400, costUsd: 0.02, coverage: "partial" },
  };
}

function turn(index: number, ply: number): TurnTelemetry {
  return {
    matchId: `match-${ply}`,
    ply: ply + 1,
    turnIndex: ply + 1,
    turnId: `turn-${ply}`,
    agentId: "codex::cli-default::default",
    model: "",
    provider: "codex",
    playerId: ply % 2 === 0 ? "white" : "black",
    playerLabel: ply % 2 === 0 ? "White" : "Black",
    fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    legalActionCount: 20,
    action: { type: "move", payload: { move: "e2e4" } },
    actionLabel: "e2e4",
    valid: true,
    latencyMs: 2000,
    retryCount: 0,
    attempts: [attempt(1)],
    stateBefore: { fen: "legacy-before", pgn: "", moves: [] },
    stateAfter: { fen: "legacy-after", pgn: "", moves: [] },
    timestamp: "2026-01-01T00:00:02.000Z",
  };
}

function synthetic(index: number, turns: number, events: number): MatchRecord {
  const history = Array.from({ length: turns }, (_value, ply) => turn(index, ply));
  const eventList: MatchEvent[] = Array.from({ length: events }, (_value, sequence) => ({ at: "2026-01-01T00:00:00.000Z", type: "agent.thinking", text: `event ${sequence}`, sequence: sequence + 1 }));
  return {
    id: `match-${index}`,
    gameId: "chess",
    gameVersion: "standard-1",
    protocolVersion: "game-action-v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "stopped",
    revision: index + 1,
    players: [
      { id: "white", label: "White", agent: { provider: "codex", model: "", name: "Codex" } },
      { id: "black", label: "Black", agent: { provider: "claude", model: "", name: "Claude" } },
    ],
    settings: { turnTimeoutSeconds: turnTimeout, maxRetries: 1, retryPolicy: "retry-invalid-once-then-forfeit", promptVersion: "v2", toolSchemaVersion: "v1", resultPolicy: "engine-terminal-with-arena-adjudication", budgets: { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null } },
    gameState: { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", pgn: "", moves: [] },
    history,
    events: eventList,
  };
}

function syntheticBattleship(index: number): MatchRecord {
  const game = new BattleshipGame();
  const state = game.createState();
  const ships = ["carrier", "battleship", "cruiser", "submarine", "destroyer"].map((ship, row) => ({ ship, start: `a${row + 1}`, orientation: "horizontal" }));
  game.applyAction(state, "player1", { type: "place_fleet", payload: { ships } });
  game.applyAction(state, "player2", { type: "place_fleet", payload: { ships } });
  for (let shot = 0; shot < 60; shot++) game.applyAction(state, game.currentPlayer(state)!, { type: "fire", payload: { coordinate: `${String.fromCharCode(101 + Math.floor(shot / 10))}${shot % 10 + 1}` } });
  const base = synthetic(index, 0, 0);
  return { ...base, gameId: game.id, gameVersion: game.version,
    players: [{ id: "player1", label: "Player 1", agent: base.players[0].agent }, { id: "player2", label: "Player 2", agent: base.players[1].agent }],
    gameState: game.serialize(state),
    history: state.entries.map((entry, turnIndex) => ({ ...turn(index, turnIndex), playerId: entry.playerId, playerLabel: game.playerLabel(entry.playerId), action: entry.action, actionLabel: game.actionLabel(entry.action), attempts: [{ ...attempt(1), action: entry.action }] })),
    events: state.entries.map((entry, turnIndex) => ({ at: "2026-01-01T00:00:00.000Z", type: "move.applied", text: game.actionLabel(entry.action), sequence: turnIndex + 1 })) };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

const results: Array<Record<string, number>> = [];
for (const count of [0, 1, 50, 100]) {
  const records = Array.from({ length: count }, (_value, index) => synthetic(index, 80, 500));
  const start = performance.now();
  const snapshot = buildSnapshot(records, []);
  const elapsed = performance.now() - start;
  results.push({ records: count, snapshotBytes: bytes(snapshot), buildMs: Number(elapsed.toFixed(2)) });
}

const longGame = synthetic(0, 150, 500);
const detailStart = performance.now();
const projected = projectRecord(longGame);
results.push({ longGameTurns: 150, detailBytes: bytes(projected), projectMs: Number((performance.now() - detailStart).toFixed(2)) });

const activeSnapshot = buildSnapshot([{ ...longGame, status: "running" }], []);
results.push({ activeDetailBytes: bytes(activeSnapshot), activeBuildMs: 0 });

const battle = syntheticBattleship(0);
const battleStart = performance.now();
const battlePublic = projectRecord(battle);
results.push({ battleshipTurns: battle.history.length, battleshipPrivateBytes: bytes(battle), battleshipPublicBytes: bytes(battlePublic), battleshipProjectionMs: Number((performance.now() - battleStart).toFixed(2)) });

const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-persistence-benchmark-"));
try {
  const store = new MatchStore(join(folder, "matches.json"));
  const series = makeSeriesV2([{ provider: "codex", model: "fixture-a", name: "A" }, { provider: "claude", model: "fixture-b", name: "B" }], 120,
    { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null },
    { mode: "exploratory", games: [{ gameId: "battleship", gameVersion: "battleship-standard-1", repetitions: 2, rolePolicy: "alternating", challengePolicy: "fixed" }] }, "11".repeat(32));
  for (const count of (process.argv.includes("--large") ? [10, 50, 100, 500, 1000] : [10, 50, 100])) {
    const records = Array.from({ length: count }, (_value, index) => index % 4 === 0 ? syntheticBattleship(index) : synthetic(index, 80, 500));
    const timings: number[] = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const start = performance.now();
      store.save(records, [series]);
      timings.push(performance.now() - start);
    }
    const readStart = performance.now();
    JSON.parse(readFileSync(store.storePath, "utf8"));
    timings.sort((a, b) => a - b);
    results.push({ persistedMatches: count, battleshipMatches: records.filter((record) => record.gameId === "battleship").length, seriesRecords: 1, bytes: statSync(store.storePath).size,
      writeMedianMs: Number(timings[2].toFixed(2)), writeP95Ms: Number(timings[4].toFixed(2)), parseMs: Number((performance.now() - readStart).toFixed(2)) });
  }
} finally { rmSync(folder, { recursive: true, force: true }); }

// Durable-store comparison. The JSON archive rewrites the whole store at every
// checkpoint (above). The durable store's per-record checkpoint should not scale
// with the number of archived records. Counts accumulate on purpose so the
// archive grows while the checkpoint cost is measured.
const durableFolder = mkdtempSync(join(os.tmpdir(), "agent-battle-durable-benchmark-"));
try {
  const durable = DurableStore.open(durableFolder);
  for (const count of (process.argv.includes("--large") ? [10, 50, 100, 500, 1000] : [10, 50, 100])) {
    const records = Array.from({ length: count }, (_value, index) => index % 4 === 0 ? syntheticBattleship(index) : synthetic(index, 80, 500));
    const bulkStart = performance.now();
    durable.repository.transaction(() => { for (const record of records) durable.saveMatch(record); });
    const bulkLoadMs = performance.now() - bulkStart;
    const target = records[records.length - 1];
    const timings: number[] = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const start = performance.now();
      durable.saveMatch({ ...target, revision: (target.revision ?? 0) + repeat + 1 });
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    results.push({
      durableArchiveMatches: durable.repository.countMatches(),
      durableAddedThisStep: count,
      durableBulkLoadMs: Number(bulkLoadMs.toFixed(2)),
      durableCheckpointMedianMs: Number(timings[2].toFixed(2)),
      durableCheckpointP95Ms: Number(timings[4].toFixed(2)),
    });
  }
  const reopenStart = performance.now();
  const archiveSize = durable.repository.countMatches();
  durable.close();
  const reopened = DurableStore.open(durableFolder);
  reopened.repository.listMatches();
  const reopenMs = performance.now() - reopenStart;
  results.push({ durableArchiveMatches: archiveSize, durableReopenAndListMs: Number(reopenMs.toFixed(2)) });
  reopened.close();
} finally { rmSync(durableFolder, { recursive: true, force: true }); }

console.log(JSON.stringify(results, null, 2));
