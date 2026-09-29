import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GameDefinition } from "../src/domain/game.js";
import { BattleshipGame } from "../src/games/battleship/BattleshipGame.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";
import { HangmanDuelGame } from "../src/games/hangman/HangmanDuelGame.js";
import { HangmanGame } from "../src/games/hangman/HangmanGame.js";
import type { GameAction, MatchResult } from "../src/shared.js";

const frequency = "etaoinshrdlcumwfgypbvkjxqz";
const seed = (label: string, index: number) => createHash("sha256").update(`${label}:${index}`).digest("hex");
const share = (outcomes: number[]) => outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
const seatShare = (winner: string | undefined, seat: string, kind: string | undefined) => kind === "draw" || !winner ? 0.5 : winner === seat ? 1 : 0;

function letterPolicy(order: string) {
  return (letters: string[]) => [...letters].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

test("offline role swaps measure seat bias without provider calls", () => {
  const independent = new HangmanGame();
  const shared = new HangmanDuelGame();
  const battle = new BattleshipGame();
  const chess = new ChessGame();
  const alphabetical = letterPolicy("abcdefghijklmnopqrstuvwxyz");
  const frequent = letterPolicy(frequency);
  const independentDraws: number[] = [];
  const sharedFirst: number[] = [];
  const sharedPaired: number[] = [];
  for (let index = 0; index < 24; index += 1) {
    const same = playHangman(independent, seed("lane", index), alphabetical, alphabetical);
    independentDraws.push(same.kind === "draw" ? 1 : 0);
    const forward = playHangman(shared, seed("shared", index), frequent, alphabetical);
    const reverse = playHangman(shared, seed("shared", index), alphabetical, frequent);
    sharedFirst.push(seatShare(forward.winnerId, "player1", forward.kind));
    const frequencyForward = seatShare(forward.winnerId, "player1", forward.kind);
    const frequencyReverse = seatShare(reverse.winnerId, "player2", reverse.kind);
    sharedPaired.push(frequencyForward - frequencyReverse);
  }
  assert.equal(share(independentDraws), 1, "identical independent-lane policies stay symmetric");
  const fleet = ["carrier", "battleship", "cruiser", "submarine", "destroyer"].map((ship, row) => ({ ship, start: `a${row + 1}`, orientation: "horizontal" as const }));
  const targets = battleCoordinates();
  let battleFirst = 0;
  for (let index = 0; index < 2; index += 1) {
    const result = playBattle(battle, fleet, targets);
    battleFirst += seatShare(result.winnerId, "player1", result.kind);
  }
  const resigned = chess.createState();
  chess.applyAction(resigned, "white", { type: "resign", payload: {} });
  const resignation = chess.result(resigned);
  const report = {
    independentIdenticalDrawShare: share(independentDraws),
    sharedFrequencyFirstSeatShare: Number(share(sharedFirst).toFixed(3)),
    sharedFrequencyPairedDifference: Number(share(sharedPaired).toFixed(3)),
    battleshipFixedFleetFirstSeatShare: battleFirst / 2,
    chessResignationWinner: resignation?.winnerId,
  };
  console.log(JSON.stringify(report));
  assert.equal(report.chessResignationWinner, "black");
  assert.ok(report.sharedFrequencyFirstSeatShare >= 0 && report.sharedFrequencyFirstSeatShare <= 1);
  assert.ok(Number.isFinite(report.sharedFrequencyPairedDifference));
  assert.equal(report.battleshipFixedFleetFirstSeatShare, 1);
});

function playHangman<S>(game: GameDefinition<S>, root: string, first: (letters: string[]) => string, second: (letters: string[]) => string): MatchResult {
  const state = game.createState(root);
  let guard = 0;
  while (!game.isTerminal(state)) {
    if (++guard > 80) throw new Error("hangman policy did not finish");
    const player = game.currentPlayer(state)!;
    const observation = game.observe(state, { matchId: "m", turnId: "t", player: { id: player, label: player, agent: { provider: "codex", model: player, name: player } }, ply: 1, turnIndex: 1, turnTimeoutMs: 1000 });
    const letters = observation.legalActions.map((action) => String(action.payload.letter));
    const letter = (player === "player1" ? first : second)(letters);
    game.applyAction(state, player, { type: "guess_letter", payload: { letter } });
  }
  const result = game.result(state);
  if (!result) throw new Error("missing hangman result");
  return result;
}

function battleCoordinates(): string[] {
  const cells: string[] = [];
  for (const file of "abcdefghij") for (let rank = 1; rank <= 10; rank += 1) cells.push(`${file}${rank}`);
  return cells;
}

function playBattle(game: BattleshipGame, fleet: Array<{ ship: string; start: string; orientation: "horizontal" }>, targets: string[]) {
  const state = game.createState();
  const place = { type: "place_fleet", payload: { ships: fleet } };
  game.applyAction(state, "player1", place);
  game.applyAction(state, "player2", place);
  const cursors = { player1: 0, player2: 0 };
  let guard = 0;
  while (!game.isTerminal(state)) {
    if (++guard > 400) throw new Error("battleship policy did not finish");
    const player = game.currentPlayer(state) as "player1" | "player2";
    const coordinate = targets[cursors[player]++];
    game.applyAction(state, player, { type: "fire", payload: { coordinate } } satisfies GameAction);
  }
  const result = game.result(state);
  if (!result) throw new Error("missing battleship result");
  return result;
}
