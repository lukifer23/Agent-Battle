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
  const white = game.observe(state, { matchId: "m1", turnId: "t1", player: seat("white"), moveNumber: 1, turnTimeoutMs: 60_000 });
  assert.equal(white.playerId, "white");
  assert.equal(white.sideToMove, "white");
  assert.equal(white.state.fen, new Chess().fen());
  assert.ok(white.legalActions.some((action) => action.type === "move" && action.payload.move === "e2e4"));
  assert.ok(white.legalActions.some((action) => action.type === "resign"));
  assert.equal(white.history.length, 0);
  const actionSchema = white.actionSchema as {
    oneOf?: unknown;
    properties: { payload: { anyOf: Array<{ properties: Record<string, { enum?: string[] }> }> } };
  };
  assert.equal(actionSchema.oneOf, undefined);
  assert.equal(actionSchema.properties.payload.anyOf[0]?.properties.move?.enum?.includes("e2e4"), true);

  play(state, "e2e4");
  const black = game.observe(state, { matchId: "m1", turnId: "t2", player: seat("black"), moveNumber: 2, turnTimeoutMs: 60_000 });
  assert.equal(black.playerId, "black");
  assert.equal(black.sideToMove, "black");
  assert.equal(black.history[0] && (black.history[0] as { uci: string }).uci, "e2e4");
  assert.ok(black.legalActions.some((action) => action.type === "move" && action.payload.move === "e7e5"));
  assert.throws(() => game.observe(state, { matchId: "m1", turnId: "wrong", player: seat("white"), moveNumber: 2, turnTimeoutMs: 1000 }));
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
