import test from "node:test";
import assert from "node:assert/strict";
import { projectRecord, summaryOf } from "../src/domain/projection.js";
import { buildSnapshot } from "../src/domain/snapshot.js";
import type { AgentAttempt, MatchEvent, MatchRecord, TurnTelemetry } from "../src/shared.js";

function attempt(index: number): AgentAttempt {
  return {
    attempt: index,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    latencyMs: 100,
    status: "valid",
    action: { type: "move", payload: { move: "e2e4" } },
    responseExcerpt: "x".repeat(1200),
    stderrExcerpt: "y".repeat(700),
    toolCalls: 0,
    usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01, coverage: "partial" },
  };
}

function record(historyLength: number, eventCount: number): MatchRecord {
  const history: TurnTelemetry[] = Array.from({ length: historyLength }, (_value, index) => ({
    matchId: "m1",
    ply: index + 1,
    turnIndex: index + 1,
    turnId: `t${index + 1}`,
    agentId: "codex::cli-default::default",
    model: "",
    provider: "codex",
    playerId: index % 2 === 0 ? "white" : "black",
    playerLabel: index % 2 === 0 ? "White" : "Black",
    fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    legalActionCount: 20,
    action: { type: "move", payload: { move: "e2e4" } },
    actionLabel: "e2e4",
    valid: true,
    latencyMs: 100,
    retryCount: 0,
    attempts: [attempt(1)],
    stateBefore: { fen: "legacy-before", pgn: "", moves: [] },
    stateAfter: { fen: "legacy-after", pgn: "", moves: [] },
    timestamp: "2026-01-01T00:00:01.000Z",
  }));
  const events: MatchEvent[] = Array.from({ length: eventCount }, (_value, index) => ({ at: "2026-01-01T00:00:00.000Z", type: "agent.thinking", text: `event ${index}`, sequence: index + 1 }));
  return {
    id: "m1",
    gameId: "chess",
    gameVersion: "standard-1",
    protocolVersion: "game-action-v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    revision: 99,
    players: [
      { id: "white", label: "White", agent: { provider: "codex", model: "", name: "Codex" } },
      { id: "black", label: "Black", agent: { provider: "claude", model: "", name: "Claude" } },
    ],
    settings: { turnTimeoutSeconds: 120, maxRetries: 1, retryPolicy: "retry-invalid-once-then-forfeit", promptVersion: "v2", toolSchemaVersion: "v1", resultPolicy: "engine-terminal-with-arena-adjudication", budgets: { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null } },
    gameState: { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", pgn: "", moves: [] },
    history,
    events,
  };
}

test("transport projection drops bulky diagnostics but keeps replay and usage", () => {
  const projected = projectRecord(record(40, 60));
  const turn = projected.history[0];
  assert.equal(turn.attempts[0].responseExcerpt, undefined);
  assert.equal(turn.attempts[0].stderrExcerpt, undefined);
  assert.equal(turn.stateBefore, undefined);
  assert.equal(turn.stateAfter, undefined);
  assert.deepEqual(turn.attempts[0].usage, { inputTokens: 100, outputTokens: 10, costUsd: 0.01, coverage: "partial" });
  assert.equal(turn.fenBefore?.startsWith("rnbq"), true);
  assert.equal(projected.events.length, 40);
  assert.equal(projected.events.at(-1)?.text, "event 59");
  assert.ok(projected.gameState);
});

test("summary projection excludes history and events", () => {
  const summary = summaryOf(record(40, 60));
  assert.equal(summary.history.length, 0);
  assert.equal(summary.events.length, 0);
  assert.equal(summary.id, "m1");
});

test("a 50-record snapshot stays well under the transport budget", () => {
  const records = Array.from({ length: 50 }, (_value, index) => ({ ...record(80, 500), id: `match-${index}`, revision: index + 1, status: "stopped" as const }));
  const snapshot = buildSnapshot(records, []);
  assert.equal(snapshot.recentMatches.length, 50);
  assert.ok(snapshot.recentMatches.every((match) => match.history.length === 0 && match.events.length === 0));
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  assert.ok(bytes < 100 * 1024, `snapshot was ${bytes} bytes`);
});

test("the active match is included as a full transport projection", () => {
  const active = record(30, 120);
  const snapshot = buildSnapshot([active, { ...record(5, 5), id: "old", status: "finished", result: { kind: "win", winnerId: "white", notation: "1-0", reason: "checkmate" } }], []);
  assert.equal(snapshot.activeMatchId, "m1");
  assert.equal(snapshot.activeMatch?.history.length, 30);
  assert.equal(snapshot.activeMatch?.events.length, 40);
  assert.equal(snapshot.activeMatch?.history[0].attempts[0].responseExcerpt, undefined);
  assert.equal(snapshot.recentMatches.find((match) => match.id === "old")?.history.length, 0);
});
