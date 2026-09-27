import test from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";
import type { GameAction, PlayerSeat } from "../src/shared.js";

const game = new ChessGame();

function seat(id: "white" | "black"): PlayerSeat {
  return { id, label: id === "white" ? "White" : "Black", agent: { provider: "codex", model: "test", name: "test" } };
}

function play(state: ReturnType<ChessGame["createState"]>, move: string) {
  const playerId = game.currentPlayer(state)!;
  const action: GameAction = { type: "move", payload: { move } };
  const validation = game.validateAction(state, playerId, action);
  assert.equal(validation.valid, true, validation.reason);
  return game.applyAction(state, playerId, action);
}

test("observation is player-specific and includes FEN, history, legal actions, and schema", () => {
  const state = game.createState();
  const white = game.observe(state, { matchId: "m1", turnId: "t1", player: seat("white"), ply: 1, turnIndex: 1, turnTimeoutMs: 60_000 });
  assert.equal(white.playerId, "white");
  assert.equal(white.sideToMove, "white");
  assert.equal(white.state.fen, new Chess().fen());
  assert.ok(white.legalActions.some((action) => action.type === "move" && action.payload.move === "e2e4"));
  assert.ok(white.legalActions.some((action) => action.type === "resign"));
  assert.equal(white.history.length, 0);
  const actionSchema = white.actionSchema as { oneOf: Array<{ properties: { type: { const: string }; payload: { properties: Record<string, { enum?: string[] }> } } }> };
  assert.equal(actionSchema.oneOf[0].properties.type.const, "move");
  assert.equal(actionSchema.oneOf[0].properties.payload.properties.move.enum?.includes("e2e4"), true);
  assert.equal(actionSchema.oneOf[1].properties.type.const, "resign");
  assert.deepEqual(actionSchema.oneOf[1].properties.payload.properties, {});

  play(state, "e2e4");
  const black = game.observe(state, { matchId: "m1", turnId: "t2", player: seat("black"), ply: 2, turnIndex: 2, turnTimeoutMs: 60_000 });
  assert.equal(black.playerId, "black");
  assert.equal(black.sideToMove, "black");
  assert.equal(black.history[0] && (black.history[0] as { uci: string }).uci, "e2e4");
  assert.ok(black.legalActions.some((action) => action.type === "move" && action.payload.move === "e7e5"));
  assert.throws(() => game.observe(state, { matchId: "m1", turnId: "wrong", player: seat("white"), ply: 2, turnIndex: 2, turnTimeoutMs: 1000 }));
});

test("legal moves apply and illegal or wrong-player actions are rejected", () => {
  const state = game.createState();
  assert.equal(game.validateAction(state, "black", { type: "move", payload: { move: "e7e5" } }).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "move", payload: { move: "e2e5" } }).valid, false);
  const next = game.applyAction(state, "white", { type: "move", payload: { move: "e2e4" } });
  assert.equal(next.chess.turn(), "b");
  assert.equal(next.chess.history().at(-1), "e4");
  assert.deepEqual(game.eventProjection(next), {
    fen: next.chess.fen(),
    pgn: next.chess.pgn(),
    move: next.moves.at(-1),
  });
  assert.throws(() => game.applyAction(state, "white", { type: "move", payload: { move: "e2e5" } }));
});

test("checkmate, stalemate, repetition, move-count draw, insufficient material, and resignation terminate", () => {
  let state = game.createState();
  state = play(state, "f2f3");
  state = play(state, "e7e5");
  state = play(state, "g2g4");
  state = play(state, "d8h4");
  assert.equal(game.isTerminal(state), true);
  assert.deepEqual(game.result(state), { kind: "win", winnerId: "black", notation: "0-1", reason: "Checkmate — black wins" });

  const stalemate = game.createState();
  stalemate.chess.load("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assert.equal(game.result(stalemate)?.reason, "Stalemate");

  state = game.createState();
  for (const move of ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"]) state = play(state, move);
  assert.equal(game.result(state)?.reason, "Threefold repetition");

  const fiftyMoves = game.createState();
  fiftyMoves.chess.load("7k/8/8/8/8/8/8/K5R1 w - - 100 50");
  assert.equal(game.result(fiftyMoves)?.reason, "Fifty-move rule");

  const insufficient = game.createState();
  insufficient.chess.load("7k/8/8/8/8/8/8/K7 w - - 0 1");
  assert.equal(game.result(insufficient)?.reason, "Insufficient material");

  const resigned = game.createState();
  game.applyAction(resigned, "white", { type: "resign", payload: {} });
  assert.deepEqual(game.result(resigned), { kind: "win", winnerId: "black", notation: "0-1", reason: "white resigned" });
});

test("serialized PGN reloads to the same authoritative position", () => {
  let state = game.createState();
  state = play(state, "e2e4");
  state = play(state, "c7c5");
  const restored = game.deserialize(game.serialize(state));
  assert.equal(restored.chess.fen(), state.chess.fen());
  assert.equal(restored.chess.pgn(), state.chess.pgn());
  assert.equal(restored.moves.length, 2);
});

test("serialization detaches move records and resignation from mutable runtime state", () => {
  const state = game.createState();
  const before = game.serialize(state);
  play(state, "e2e4");
  assert.equal(before.moves.length, 0);
  assert.equal(before.fen, new Chess().fen());
  assert.equal(before.pgn, new Chess().pgn());
  const after = game.serialize(state);
  after.moves[0]!.san = "tampered";
  assert.equal(state.moves[0]?.san, "e4");
  game.applyAction(state, "black", { type: "resign", payload: {} });
  const resigned = game.serialize(state);
  resigned.resignation!.playerId = "white";
  assert.equal(state.resignation?.playerId, "black");
});

test("action envelope and chess payload keys are strictly validated", () => {
  const state = game.createState();
  assert.equal(game.validateAction(state, "white", { type: "move", payload: { move: "e2e4" } }).valid, true);
  assert.equal(game.validateAction(state, "white", { type: "move", payload: { move: "e2e4", extra: "accepted" } }).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "move", payload: { move: "E2E4" } }).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "move", payload: { move: "e2e4" }, extra: true }).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "resign", payload: [] }).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "resign", payload: { move: "e2e4" } }).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "resign", payload: {} }).valid, true);
  assert.equal(game.validateAction(state, "white", null).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "move", payload: null }).valid, false);
  assert.equal(game.validateAction(state, "white", { type: "jump", payload: {} }).valid, false);
  assert.throws(() => game.applyAction(state, "white", { type: "move", payload: { move: "E2E4" } }));
  assert.throws(() => game.applyAction(state, "white", { type: "move", payload: { move: "e2e4", extra: 1 } }));
  assert.equal(state.chess.history().length, 0);
});

test("lowercase UCI is applied verbatim and drives telemetry and replay", () => {
  const state = game.createState();
  const next = game.applyAction(state, "white", { type: "move", payload: { move: "e2e4" } });
  assert.equal(next.moves[0].uci, "e2e4");
  assert.equal(game.eventProjection(next).fen, next.chess.fen());
});

test("saved state rejects tampered move records and resignation metadata", () => {
  let state = game.createState();
  state = play(state, "e2e4");
  state = play(state, "e7e5");
  const snapshot = game.serialize(state) as { moves: Array<{ ply: number; color: string }>; resignation?: unknown };
  assert.doesNotThrow(() => game.deserialize(snapshot));

  const badPly = JSON.parse(JSON.stringify(snapshot)) as { moves: Array<{ ply: number }> };
  badPly.moves[0].ply = 5;
  assert.throws(() => game.deserialize(badPly), /ply/i);

  const badColor = JSON.parse(JSON.stringify(snapshot)) as { moves: Array<{ color: string }> };
  badColor.moves[0].color = "black";
  assert.throws(() => game.deserialize(badColor), /color/i);

  const badUci = JSON.parse(JSON.stringify(snapshot)) as { moves: Array<{ uci: string }> };
  badUci.moves[1].uci = "E7E5";
  assert.throws(() => game.deserialize(badUci), /UCI/i);

  const badResignation = JSON.parse(JSON.stringify(snapshot)) as { resignation?: unknown };
  badResignation.resignation = { playerId: "nobody", at: "invalid" };
  assert.throws(() => game.deserialize(badResignation), /resign/i);
});
