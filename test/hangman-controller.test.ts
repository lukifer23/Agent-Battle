import test from "node:test";
import assert from "node:assert/strict";
import { MatchController } from "../src/domain/MatchController.js";
import { AgentRegistry, type AgentReply } from "../src/domain/agent.js";
import { defaultGames } from "../src/domain/defaultGames.js";
import { projectRecord, summaryOf } from "../src/domain/projection.js";
import { HangmanGame, type HangmanState } from "../src/games/hangman/HangmanGame.js";
import type { GameAction, GameObservation, MatchRecord } from "../src/shared.js";
import { matchRequests } from "../src/domain/usage.js";
const game = new HangmanGame();
const config = { provider: "codex" as const, model: "fixture", name: "Fixture" };
const providers = [{ provider: "codex" as const, installed: true, defaultModel: "fixture" }];
function harness(response: (o: GameObservation) => GameAction, maxRequests = 200) {
  const records: MatchRecord[] = [];
  let saved: MatchRecord[] = [];
  const observations: GameObservation[] = [];
  const publicPayloads: unknown[] = [];
  const agents = new AgentRegistry().register("codex", (config) => ({ id: "fixture", config, initialize: async () => {}, shutdown: async () => {}, act: async (observation): Promise<AgentReply> => {
    assert.equal(saved[0].pendingTurn?.attempts.at(-1)?.status, "started", "reservation must be durable before spawn");
    observations.push(observation);
    return { action: response(observation), latencyMs: 1, responseExcerpt: "private diagnostic", stderrExcerpt: "private stderr", toolCalls: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } };
  } }));
  const controller = new MatchController(defaultGames, agents, records, async () => providers, (record, event) => {
    if (!event) saved = structuredClone(records);
    else { publicPayloads.push(event); if (!(record.gameState as HangmanState).lanes || !game.isTerminal(record.gameState as HangmanState)) publicPayloads.push(projectRecord(record)); }
  });
  return { controller, observations, publicPayloads, create: () => controller.create({ gameId: "hangman", players: { player1: config, player2: config }, turnTimeoutSeconds: 30, budgets: { maxRequests } }) };
}
async function finish(controller: MatchController, id: string) {
  const deadline = Date.now() + 3000;
  while (["ready", "running"].includes(controller.get(id)!.status)) {
    if (Date.now() > deadline) throw new Error("Controller did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await controller.shutdown();
  return controller.get(id)!;
}
test("Hangman completes both lanes, isolates observations, seals early solve, and preserves durable results", async () => {
  let word = "";
  const h = harness((o) => o.playerId === "player1" || o.state.actionsTaken === 2 ? { type: "solve", payload: { word } } : o.legalActions[0]);
  const match = await h.create(); word = (match.gameState as HangmanState).word;
  await h.controller.start(match.id);
  const done = await finish(h.controller, match.id);
  assert.equal(done.status, "finished"); assert.equal(done.result?.winnerId, "player1");
  assert.equal(h.observations.filter((o) => o.playerId === "player1").length, 1);
  for (const o of h.observations) {
    assert.equal(JSON.stringify(o).includes(word), false);
    assert.equal(JSON.stringify(o).includes(o.playerId === "player1" ? "player2" : "player1"), false);
  }
  // Completed-event reveal is permitted only after both lanes finish.
  for (const payload of h.publicPayloads) {
    const encoded = JSON.stringify(payload);
    if (encoded.includes(word)) assert.match(encoded, /"terminal":true/);
    assert.equal(encoded.includes("private diagnostic"), false);
    assert.equal(encoded.includes("private stderr"), false);
  }
  assert.deepEqual(game.deserialize(done.gameState), done.gameState);
  assert.equal(defaultGames.validateRecord(done), undefined);
  assert.equal((projectRecord(done).gameState as { word: string }).word, word);
  assert.equal(JSON.stringify(summaryOf(done)).includes(word), false);
  assert.equal(new Set(done.history.flatMap((t) => t.attempts.map((a) => a.invocationId))).size, 4);
});
test("exhausted correction forfeits only one lane and remaining lane completes", async () => {
  let word = "";
  const h = harness((o) => o.playerId === "player1" ? { type: "invalid", payload: {} } : { type: "solve", payload: { word } });
  const match = await h.create(); word = (match.gameState as HangmanState).word;
  await h.controller.start(match.id); const done = await finish(h.controller, match.id);
  assert.equal(done.status, "finished"); assert.equal(done.result?.winnerId, "player2");
  assert.deepEqual(h.observations.map((o) => o.playerId), ["player1", "player1", "player2"]);
  assert.equal((done.gameState as HangmanState).lanes.player1.status, "forfeit");
  assert.equal(projectRecord(done).history[0].actionLabel, undefined);
});
test("one-request budget blocks a correction invocation and does not award a result or reveal", async () => {
  const h = harness(() => ({ type: "invalid", payload: {} }), 1);
  const match = await h.create();
  await h.controller.start(match.id); const done = await finish(h.controller, match.id);
  assert.equal(h.observations.length, 1); assert.equal(matchRequests(done), 1);
  assert.equal(done.status, "stopped"); assert.equal(done.result, undefined);
  const publicMatch = projectRecord(done);
  assert.equal("word" in (publicMatch.gameState as object), false);
  assert.ok(publicMatch.replay?.every((frame) => !("word" in (frame as object))));
});
test("forged Hangman derived result fails registry validation", async () => {
  let word = "";
  const h = harness(() => ({ type: "solve", payload: { word } }));
  const match = await h.create(); word = (match.gameState as HangmanState).word;
  await h.controller.start(match.id); const done = await finish(h.controller, match.id);
  const forged = structuredClone(done); forged.result = { kind: "win", winnerId: "player1", notation: "1-0", reason: "invented" };
  assert.ok(defaultGames.validateRecord(forged));
});

test("restart accounts for an unfinished reservation without replaying or forgetting it", async () => {
  const h = harness(() => ({ type: "invalid", payload: {} }));
  const match = await h.create();
  match.status = "running";
  match.pendingTurn = { turnId: "turn", turnIndex: 1, ply: 1, playerId: "player1", startedAt: new Date().toISOString(), attempts: [{ attempt: 1, invocationId: "00000000-0000-0000-0000-000000000001", startedAt: new Date().toISOString(), status: "started", toolCalls: null, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } }] };
  const saved = structuredClone(match);
  let commits = 0;
  const restored = new MatchController(defaultGames, new AgentRegistry(), [saved], async () => providers, (_record, event) => { if (!event) commits++; });
  assert.equal(restored.get(saved.id)?.status, "interrupted");
  assert.equal(restored.get(saved.id)?.pendingTurn?.attempts[0].status, "interrupted");
  assert.equal(matchRequests(restored.get(saved.id)!), 1);
  assert.equal(commits, 1);
  assert.equal(restored.get(saved.id)?.pendingTurn?.attempts[0].usage.costUsd, null);
});

test("a forged lane forfeit requires corresponding invalid request evidence", async () => {
  const h = harness(() => ({ type: "invalid", payload: {} }));
  const match = await h.create();
  const state = game.deserialize(match.gameState); game.forfeit(state, "player1");
  match.gameState = game.serialize(state);
  assert.match(defaultGames.validateRecord(match) ?? "", /history lacks telemetry/);
});
