import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { AgentExecutionError, AgentRegistry, type AgentAdapter, type AgentReply } from "../src/domain/agent.js";
import { MatchController } from "../src/domain/MatchController.js";
import { GameRegistry } from "../src/domain/game.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";
import type { GameAction, GameObservation, MatchRecord, PlayerConfig, ProviderInfo } from "../src/shared.js";
import { MatchStore } from "../src/server/store.js";

const providers: ProviderInfo[] = [{ provider: "codex", installed: true, executable: "/fake/codex", defaultModel: "test" }];

class ScriptedAgent implements AgentAdapter {
  readonly id: string;
  readonly observations: GameObservation[] = [];
  shutdownCount = 0;
  constructor(readonly config: PlayerConfig, private readonly actFn: (observation: GameObservation, call: number) => Promise<GameAction>) {
    this.id = `test:${config.model}`;
  }
  async initialize(): Promise<void> {}
  async act(observation: GameObservation): Promise<AgentReply> {
    this.observations.push(observation);
    const action = await this.actFn(observation, this.observations.length);
    return {
      action,
      latencyMs: 12,
      responseExcerpt: JSON.stringify(action),
      stderrExcerpt: "",
      toolCalls: 0,
      usage: { inputTokens: 50, outputTokens: 8, costUsd: null },
    };
  }
  async shutdown(): Promise<void> { this.shutdownCount += 1; }
}

function harness(
  response: (model: string, observation: GameObservation, call: number) => Promise<GameAction>,
  records: MatchRecord[] = [],
  onChange: (matches: MatchRecord[]) => void = () => undefined,
) {
  const players = new Map<string, ScriptedAgent[]>();
  const registry = new AgentRegistry();
  registry.register("codex", (config) => {
    const agent = new ScriptedAgent(config, (observation, call) => response(config.model, observation, call));
    const list = players.get(config.model) ?? [];
    list.push(agent);
    players.set(config.model, list);
    return agent;
  });
  const game = new ChessGame();
  const controller = new MatchController(
    new GameRegistry().register(game), registry, records, async () => providers,
    () => onChange(records),
  );
  return { controller, players };
}

function config(model: string): PlayerConfig {
  return { provider: "codex", model, name: `Codex · ${model}` };
}

async function create(controller: MatchController, whiteModel = "white-model", blackModel = "black-model") {
  return controller.create({ gameId: "chess", players: { white: config(whiteModel), black: config(blackModel) }, turnTimeoutSeconds: 30 });
}

async function waitFor(controller: MatchController, id: string, statuses: string[]): Promise<MatchRecord> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const match = controller.get(id)!;
    if (statuses.includes(match.status)) return match;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for match state ${statuses.join(", ")}; current=${controller.get(id)?.status}`);
}

const action = (move: string): GameAction => ({ type: "move", payload: { move } });
const resign: GameAction = { type: "resign", payload: {} };

test("Codex-vs-Codex controller alternates correct player observations through checkmate", async () => {
  const whiteMoves = [action("f2f3"), action("g2g4")];
  const blackMoves = [action("e7e5"), action("d8h4")];
  const { controller, players } = harness(async (model) => {
    const moves = model === "white-model" ? whiteMoves : blackMoves;
    const result = moves.shift();
    if (!result) throw new Error(`${model} received more moves than expected.`);
    return result;
  });
  const match = await create(controller);
  await controller.start(match.id);
  const done = await waitFor(controller, match.id, ["finished"]);
  assert.equal(done.result?.notation, "0-1");
  assert.equal(done.result?.reason, "Checkmate — black wins");
  assert.equal((done.gameState as { moves: unknown[] }).moves.length, 4);
  assert.match((done.gameState as { pgn: string }).pgn, /Qh4# 0-1$/);
  assert.deepEqual(players.get("white-model")?.[0].observations.map((item) => item.playerId), ["white", "white"]);
  assert.deepEqual(players.get("black-model")?.[0].observations.map((item) => item.playerId), ["black", "black"]);
  assert.equal(done.history.length, 4);
  assert.equal(done.history[0].fenBefore?.includes(" w "), true);
  assert.equal(done.history[1].fenBefore?.includes(" b "), true);
  assert.equal(done.history[0].attempts[0].usage.inputTokens, 50);
  assert.equal(done.history[0].retryCount, 0);
});

test("invalid action is rejected, explained in a fresh observation, and retried once", async () => {
  const { controller, players } = harness(async (_model, _observation, call) => call === 1 ? action("a1a8") : resign);
  const match = await create(controller);
  await controller.start(match.id);
  const done = await waitFor(controller, match.id, ["finished"]);
  assert.equal(done.result?.winnerId, "black");
  assert.equal(done.result?.reason, "white resigned");
  const white = players.get("white-model")?.[0];
  assert.equal(white?.observations.length, 2);
  assert.match(white?.observations[1].feedback ?? "", /illegal/i);
  assert.equal(done.history[0].retryCount, 1);
  assert.equal(done.history[0].attempts[0].status, "invalid");
  assert.equal(done.history[0].attempts[1].status, "valid");
});

test("controller enforces a timeout and forfeits after its bounded retry", async () => {
  const { controller, players } = harness(async () => new Promise<GameAction>(() => undefined));
  const match = await create(controller);
  match.settings.turnTimeoutSeconds = 0.04;
  await controller.start(match.id);
  const done = await waitFor(controller, match.id, ["forfeit"]);
  assert.equal(done.result?.winnerId, "black");
  assert.equal(done.history[0].attempts.length, 2);
  assert.ok(done.history[0].attempts.every((attempt) => attempt.status === "timeout"));
  assert.ok((players.get("white-model")?.[0].shutdownCount ?? 0) >= 2);
});

test("CLI execution failure is visible and does not count as an opponent victory", async () => {
  const registryRecords: MatchRecord[] = [];
  const { controller } = harness(async () => { throw new AgentExecutionError("simulated provider failure"); }, registryRecords);
  const match = await create(controller);
  await controller.start(match.id);
  const done = await waitFor(controller, match.id, ["error"]);
  assert.match(done.error ?? "", /simulated provider failure/);
  assert.equal(done.result, undefined);
  assert.equal(done.history[0].attempts[0].status, "error");
});

test("saved match reload restores canonical chess state and replay history", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-store-test-"));
  try {
    const store = new MatchStore(join(folder, "matches.json"));
    const records: MatchRecord[] = [];
    const { controller } = harness(async (model) => {
      const moves = model === "white-model" ? ["f2f3", "g2g4"] : ["e7e5", "d8h4"];
      const ply = records[0]?.history.filter((turn) => turn.valid && turn.playerId === (model === "white-model" ? "white" : "black")).length ?? 0;
      const move = moves[ply];
      if (!move) throw new Error("Missing scripted move.");
      return action(move);
    }, records, (items) => store.save(items));
    const match = await create(controller);
    await controller.start(match.id);
    await waitFor(controller, match.id, ["finished"]);
    const reloaded = store.load();
    assert.equal(reloaded.length, 1);
    const restoredHarness = harness(async () => resign, reloaded);
    assert.equal(restoredHarness.controller.get(match.id)?.status, "finished");
    assert.equal((restoredHarness.controller.get(match.id)?.gameState as { moves: unknown[] }).moves.length, 4);
    assert.equal(restoredHarness.controller.get(match.id)?.result?.notation, "0-1");
    assert.equal(restoredHarness.controller.get(match.id)?.history[0]?.stateBefore, undefined);
    assert.equal(restoredHarness.controller.get(match.id)?.history[0]?.stateAfter, undefined);
    assert.match(restoredHarness.controller.get(match.id)?.history[0]?.fenBefore ?? "", /^rnbq/);
    assert.match(restoredHarness.controller.get(match.id)?.history[0]?.fenAfter ?? "", /^rnbq/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
