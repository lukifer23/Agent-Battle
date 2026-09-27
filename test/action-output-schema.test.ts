import test from "node:test";
import assert from "node:assert/strict";
import { actionOutputSchema } from "../src/server/actionOutputSchema.js";
import { HangmanGame } from "../src/games/hangman/HangmanGame.js";
test("CLI output schema uses supported root envelope while observation keeps exact action variants", () => {
  const game = new HangmanGame(); const state = game.createState("00".repeat(32));
  const observation = game.observe(state, { matchId: "m", turnId: "t", player: { id: "player1", label: "Player 1", agent: { provider: "codex", model: "fixture", name: "fixture" } }, ply: 1, turnIndex: 1, turnTimeoutMs: 1000 });
  const serialized = JSON.stringify(observation.actionSchema);
  const output = actionOutputSchema(observation.actionSchema);
  assert.equal(output.oneOf, undefined); assert.equal(output.type, "object"); assert.ok(output.properties);
  assert.equal(JSON.stringify(observation.actionSchema), serialized);
  assert.equal(game.validateAction(state, "player1", { type: "guess_letter", payload: { word: state.word } }).valid, false);
  assert.equal(game.validateAction(state, "player1", { type: "solve", payload: { letter: "a" } }).valid, false);
});
