import { buildSnapshot } from "../src/domain/snapshot.js";
import { projectRecord } from "../src/domain/projection.js";
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

console.log(JSON.stringify(results, null, 2));
