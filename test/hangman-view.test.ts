import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArenaRouter } from "../src/components/ArenaRouter.js";
import { HangmanGame } from "../src/games/hangman/HangmanGame.js";
import type { PublicMatchDetail } from "../src/shared.js";

function completedMatch(): PublicMatchDetail {
  const game = new HangmanGame();
  const state = game.createState("00".repeat(32));
  game.applyAction(state, "player1", { type: "solve", payload: { word: state.word } });
  game.applyAction(state, "player2", { type: "guess_letter", payload: { letter: "z" } });
  game.applyAction(state, "player2", { type: "solve", payload: { word: state.word } });
  return {
    id: "view-test", gameId: game.id, gameVersion: game.version, protocolVersion: "game-action-v1",
    createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", status: "finished", revision: 1, actionCount: 3,
    players: [{ id: "player1", label: "Player 1", agent: { provider: "claude", model: "a", name: "a" } }, { id: "player2", label: "Player 2", agent: { provider: "claude", model: "b", name: "b" } }],
    timeControl: { maxMinutes: 10, turnSeconds: 120, mode: "active" },
    settings: { turnTimeoutSeconds: 120, maxRetries: 1, retryPolicy: "retry-invalid-once-then-forfeit", promptVersion: "test", toolSchemaVersion: "test", resultPolicy: "engine-terminal-with-arena-adjudication", budgets: { maxPlies: 150, maxRequests: 60, maxWallMinutes: 10, maxReportedCostUsd: 2 } },
    gameState: game.publicState(state), replay: game.publicReplay(state), result: game.result(state), history: [], events: [],
  };
}
const render = (match: PublicMatchDetail, replayPly: number | null) => renderToStaticMarkup(createElement(ArenaRouter, {
  match, replayPly, chess: { boardFen: "", boardOrientation: "white", squareStyles: {}, summary: "" },
}));

test("Hangman router uses shared replay position and hides the final secret and result in historical frames", () => {
  const match = completedMatch();
  const initial = render(match, 0);
  assert.match(initial, /_ _ _ _ _/);
  assert.doesNotMatch(initial, /night|THE WORD|Player 1 wins|Solved · sealed/);
  const sealed = render(match, 1);
  assert.match(sealed, /Solved · sealed/);
  assert.doesNotMatch(sealed, /night|THE WORD|Player 1 wins/);
  const latest = render(match, null);
  assert.match(latest, /night/);
  assert.match(latest, /THE WORD/);
  assert.match(latest, /Player 1 wins/);
  assert.equal(render(match, 3), latest);
  assert.doesNotMatch(latest, /type="range"/, "only the shared replay control owns navigation");
});


test("unfinished Hangman lanes show the match lifecycle rather than ACTIVE after a stop", () => {
  const match = completedMatch();
  match.gameState = match.replay![0];
  delete match.result;
  for (const status of ["paused", "error", "stopped", "interrupted"] as const) {
    match.status = status;
    const html = render(match, null);
    assert.match(html, new RegExp(`>${status.toUpperCase()}<`));
    assert.doesNotMatch(html, />ACTIVE<|>THINKING<|>WAITING</);
  }
});
