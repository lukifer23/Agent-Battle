import test from "node:test";
import assert from "node:assert/strict";
import { applyMatchEvent, applyPresentationEvent } from "../src/client/matchEvents.js";
import { projectRecord, summaryOf } from "../src/domain/projection.js";
import type { AppState, MatchEvent, MatchRecord } from "../src/shared.js";

const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function runningState(): AppState {
  const match: MatchRecord = {
    id: "match-1",
    gameId: "chess",
    gameVersion: "standard-1",
    protocolVersion: "game-action-v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    revision: 0,
    players: [
      { id: "white", label: "White", agent: { provider: "codex", model: "", name: "Codex" } },
      { id: "black", label: "Black", agent: { provider: "claude", model: "", name: "Claude Code" } },
    ],
    settings: { turnTimeoutSeconds: 60, maxRetries: 1, retryPolicy: "retry-invalid-once-then-forfeit", promptVersion: "observation-v2", toolSchemaVersion: "action-v1", resultPolicy: "engine-terminal-with-arena-adjudication", budgets: { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null } },
    gameState: { fen: initialFen, pgn: "*", moves: [] },
    history: [],
    events: [],
    currentPlayerId: "white",
  };
  return { revision: 0, providers: [], activeMatchId: match.id, activeMatch: projectRecord(match), recentMatches: [summaryOf(match)] };
}

test("move events update the spectator board and replay without replacing the match snapshot", () => {
  const state = runningState();
  const event: MatchEvent = {
    at: "2026-01-01T00:00:03.000Z",
    type: "move.applied",
    text: "Codex played e2e4",
    playerId: "white",
    payload: {
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      move: { ply: 1, color: "white", san: "e4", uci: "e2e4", fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", at: "2026-01-01T00:00:03.000Z" },
    },
  };

  const updated = applyMatchEvent(state, "match-1", event);
  const match = updated.activeMatch;
  assert.ok(match);
  assert.equal((match.gameState as { fen: string }).fen, event.payload?.fen);
  assert.equal((match.gameState as { moves: unknown[] }).moves.length, 1);
  assert.equal(match.events.at(-1), event);
  assert.equal((state.activeMatch?.gameState as { moves: unknown[] }).moves.length, 0);
});

test("terminal events update the result and clear the active match", () => {
  const event: MatchEvent = {
    at: "2026-01-01T00:01:00.000Z",
    type: "match.finished",
    text: "0-1 · Checkmate — black wins",
    payload: { result: "0-1", kind: "win", winnerId: "black", reason: "Checkmate — black wins", status: "finished" },
  };

  const updated = applyMatchEvent(runningState(), "match-1", event);
  assert.equal(updated.activeMatch, null);
  assert.equal(updated.recentMatches[0]?.status, "finished");
  assert.deepEqual(updated.recentMatches[0]?.result, {
    kind: "win", winnerId: "black", notation: "0-1", reason: "Checkmate — black wins",
  });
});

test("the reducer is idempotent and ignores stale revisions", () => {
  const event: MatchEvent = {
    at: "2026-01-01T00:00:03.000Z",
    type: "move.applied",
    text: "Codex played e2e4",
    playerId: "white",
    payload: { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", move: { ply: 1, color: "white", san: "e4", uci: "e2e4", fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", at: "2026-01-01T00:00:03.000Z" } },
  };
  const once = applyMatchEvent(runningState(), "match-1", event, 5);
  assert.equal(once.recentMatches[0]?.revision, 5);
  const twice = applyMatchEvent(once, "match-1", event, 5);
  assert.equal(twice.recentMatches[0], once.recentMatches[0]);
  const stale = applyMatchEvent(once, "match-1", { ...event, text: "stale" }, 4);
  assert.equal(stale.recentMatches[0], once.recentMatches[0]);
});

test("presentation events leave the durable revision unchanged", () => {
  const event: MatchEvent = { at: "2026-01-01T00:00:01.000Z", type: "agent.thinking", text: "Thinking" };
  const updated = applyPresentationEvent(runningState(), "match-1", event);
  assert.equal(updated.recentMatches[0]?.revision, 0);
  assert.equal("events" in updated.recentMatches[0], false);
  assert.equal(updated.activeMatch?.events[0], event);
});
