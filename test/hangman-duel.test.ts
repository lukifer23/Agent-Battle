import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HangmanDuelGame } from "../src/games/hangman/HangmanDuelGame.js";
import { HangmanGame } from "../src/games/hangman/HangmanGame.js";
import { defaultGames } from "../src/domain/defaultGames.js";
import { MatchController } from "../src/domain/MatchController.js";
import { AgentRegistry, type AgentReply } from "../src/domain/agent.js";
import { projectRecord } from "../src/domain/projection.js";
import { ArenaRouter } from "../src/components/ArenaRouter.js";
import { makeSeriesV2 } from "../src/server/series.js";
import type { GameObservation, MatchRecord } from "../src/shared.js";
const game = new HangmanDuelGame();
const seed = "00".repeat(32);
const guess = (letter: string) => ({ type: "guess_letter", payload: { letter } });
const solve = (word: string) => ({ type: "solve", payload: { word } });
const context = (id: string) => ({ matchId: "m", turnId: "t", player: { id, label: id, agent: { provider: "claude" as const, model: id, name: id } }, ply: 2, turnIndex: 2, turnTimeoutMs: 30_000 });

test("shared guesses affect the opponent's observation, legal actions and score", () => {
  const state = game.createState(seed);
  game.applyAction(state, "player1", guess("n"));
  const observation = game.observe(state, context("player2"));
  assert.equal(observation.state.pattern, "n _ _ _ _");
  assert.deepEqual(observation.state.guessedLetters, ["n"]);
  assert.deepEqual(observation.history, [{ playerId: "player1", action: guess("n"), points: 1, revealedPositions: [0], correct: true }]);
  assert.equal(observation.legalActions.some((action) => action.payload.letter === "n"), false);
  assert.equal(game.validateAction(state, "player2", guess("n")).valid, false);
  assert.equal(game.validateAction(state, "player1", guess("i")).valid, false);
  assert.equal(JSON.stringify(observation).includes(state.word), false);
  assert.equal(JSON.stringify(observation).includes(state.provenance.seed), false);
  game.applyAction(state, "player2", solve(state.word));
  assert.equal(state.players.player2.points, 6);
  assert.equal(game.result(state)?.winnerId, "player2");
});

test("misses lose points, shared limit ends the match, tied scores draw", () => {
  const state = game.createState(seed);
  for (let i = 0; i < 4; i++) game.applyAction(state, game.currentPlayer(state)!, solve("zzzzz"));
  assert.equal(state.misses, 8);
  assert.equal(state.players.player1.points, -4);
  assert.equal(game.result(state)?.kind, "draw");
  assert.equal(game.currentPlayer(state), null);
  assert.equal(game.validateAction(state, "player1", guess("a")).valid, false);
});

test("letter completion earns bonus, full reveal ends once, and forfeit awards opponent", () => {
  const state = game.createState(seed);
  for (const letter of state.word) game.applyAction(state, game.currentPlayer(state)!, guess(letter));
  assert.equal(state.players.player1.points, 5);
  assert.equal(state.players.player2.points, 2);
  assert.equal(game.result(state)?.winnerId, "player1");
  const forfeited = game.createState(seed); game.forfeit(forfeited, "player1");
  assert.equal(game.result(forfeited)?.winnerId, "player2");
  assert.deepEqual(game.deserialize(forfeited), forfeited);
});

test("all repeated positions score, replay hides earlier word, and forged scores are rejected", () => {
  let state = game.createState(seed);
  for (let i = 1; new Set(state.word).size === state.word.length; i++) state = game.createState(i.toString(16).padStart(64, "0"));
  const letter = [...state.word].find((c) => state.word.indexOf(c) !== state.word.lastIndexOf(c))!;
  const count = [...state.word].filter((c) => c === letter).length;
  game.applyAction(state, "player1", guess(letter));
  assert.equal(state.players.player1.points, count);
  game.applyAction(state, "player2", solve(state.word));
  assert.deepEqual(game.deserialize(game.serialize(state)), state);
  assert.equal(JSON.stringify(game.publicReplay(state).slice(0,-1)).includes(state.word), false);
  const forged = game.serialize(state); forged.players.player1.points++;
  assert.throws(() => game.deserialize(forged));
});

test("registry defaults to direct contest while retaining legacy rules and balanced series", () => {
  assert.equal(defaultGames.get("hangman").version, game.version);
  const legacy = defaultGames.get("hangman", "independent-lanes-1");
  assert.deepEqual(legacy.deserialize(new HangmanGame().createState(seed)), new HangmanGame().createState(seed));
  const agents = [{ provider: "claude" as const, model: "a", name: "a" }, { provider: "claude" as const, model: "b", name: "b" }] as const;
  const budgets = { maxPlies: 150, maxRequests: 30, maxWallMinutes: 30, maxReportedCostUsd: null };
  assert.throws(() => makeSeriesV2([...agents], 30, budgets, { mode: "strict", games: [{ gameId: "hangman", gameVersion: game.version, repetitions: 1, rolePolicy: "alternating", challengePolicy: "seeded" }] }), /even/);
  const balanced = makeSeriesV2([...agents], 30, budgets, { mode: "strict", games: [{ gameId: "hangman", gameVersion: game.version, repetitions: 2, rolePolicy: "alternating", challengePolicy: "seeded" }] });
  assert.equal(balanced.slots[0].challengeSeed, balanced.slots[1].challengeSeed);
  assert.notDeepEqual(balanced.slots[0].roles, balanced.slots[1].roles);
  assert.equal(defaultGames.list().filter((item) => item.id === "hangman").length, 1);

});

test("controller routes opponent effects to distinct adapters, records fast reasoning, persists and renders one board", async () => {
  const records: MatchRecord[] = [];
  const observations: Array<{ model: string; observation: GameObservation }> = [];
  let saved: MatchRecord[] = [];
  const agents = new AgentRegistry().register("claude", (config) => ({ id: config.model, config, initialize: async () => {}, shutdown: async () => {}, act: async (observation): Promise<AgentReply> => {
    observations.push({ model: config.model, observation });
    return { action: observation.playerId === "player1" ? guess("n") : solve("night"), latencyMs: 1, toolCalls: 0, resolvedModel: config.model, responseExcerpt: "private", stderrExcerpt: "", usage: { inputTokens: 1, outputTokens: 1, costUsd: null, coverage: "partial" } };
  } }));
  const controller = new MatchController(defaultGames, agents, records, async () => [{ provider: "claude", installed: true, defaultModel: "" }], (_m, event) => { if (!event) saved = structuredClone(records); });
  const match = await controller.create({ gameId: "hangman", challengeSeed: seed, players: { player1: { provider: "claude", model: "haiku-test", name: "a" }, player2: { provider: "claude", model: "sonnet-test", name: "b" } }, turnTimeoutSeconds: 30 });
  assert.equal(match.players[0].agent.reasoning, "none");
  await controller.start(match.id);
  const deadline = Date.now() + 3000;
  while (match.status === "running") { if (Date.now() > deadline) throw new Error("Match stalled"); await new Promise((resolve) => setTimeout(resolve,5)); }
  assert.equal(match.status, "finished");
  assert.deepEqual(observations.map((x) => [x.model, x.observation.playerId]), [["haiku-test","player1"],["sonnet-test","player2"]]);
  assert.equal(observations[1].observation.state.pattern, "n _ _ _ _");
  assert.equal(JSON.stringify(observations).includes('"word":"night"'), false);
  assert.equal(defaultGames.validateRecord(saved[0]), undefined);
  const detail = projectRecord(match);
  const render = (replayPly: number | null) => renderToStaticMarkup(createElement(ArenaRouter, { match: detail, replayPly, chess: { boardFen: "", boardOrientation: "white", squareStyles: {}, summary: "" } }));
  assert.match(render(null), /night/);
  assert.doesNotMatch(render(0), /night|THE WORD|wins/);
  assert.match(render(1), /n _ _ _ _/);
  assert.equal((render(null).match(/aria-label="Shared Hangman board"/g) ?? []).length, 1);
  assert.match(render(null), /haiku-test/); assert.match(render(null), /sonnet-test/);
  // SSE can deliver running status before the first player and board projection.
  detail.status = "running";
  delete detail.currentPlayerId;
  detail.gameState = detail.replay![0];
  delete detail.result;
  assert.match(render(null), /Preparing the next turn/);
  assert.doesNotMatch(render(null), /wins|night/);
  detail.currentPlayerId = "player1";
  assert.match(render(null), /haiku-test is thinking/);
  await controller.shutdown();
});
