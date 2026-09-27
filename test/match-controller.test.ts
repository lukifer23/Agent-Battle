import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { AgentExecutionError, AgentRegistry, type AgentAdapter, type AgentReply, type AttemptControl } from "../src/domain/agent.js";
import { MatchController } from "../src/domain/MatchController.js";
import { GameRegistry, type GameDefinition, type ObservationContext } from "../src/domain/game.js";
import { parseActionEnvelope } from "../src/domain/actions.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";
import type { GameAction, GameObservation, MatchRecord, PlayerConfig, ProviderInfo } from "../src/shared.js";
import { MatchStore } from "../src/server/store.js";

const providers: ProviderInfo[] = [{ provider: "codex", installed: true, executable: "/fake/codex", version: "test", defaultModel: "test" }];

class ScriptedAgent implements AgentAdapter {
  readonly id: string;
  readonly observations: GameObservation[] = [];
  shutdownCount = 0;
  constructor(readonly config: PlayerConfig, private readonly actFn: (observation: GameObservation, call: number) => Promise<GameAction>) {
    this.id = `test:${config.model}`;
  }
  async initialize(): Promise<void> {}
  async act(observation: GameObservation, control: AttemptControl): Promise<AgentReply> {
    this.observations.push(observation);
    const action = await Promise.race([
      this.actFn(observation, this.observations.length),
      new Promise<never>((_resolve, reject) => {
        if (control.signal.aborted) { reject(control.signal.reason); return; }
        control.signal.addEventListener("abort", () => reject(control.signal.reason), { once: true });
      }),
    ]);
    return {
      action,
      latencyMs: 12,
      responseExcerpt: JSON.stringify(action),
      stderrExcerpt: "",
      toolCalls: 0,
      usage: { inputTokens: 50, outputTokens: 8, costUsd: null, coverage: "partial" },
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
    (_record, event) => { if (!event) onChange(records); },
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
  while (true) {
    const match = controller.get(id)!;
    if (statuses.includes(match.status)) return match;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for match state ${statuses.join(", ")}; current=${match.status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-forfeit-reload-"));
  try {
    const store = new MatchStore(join(folder, "matches.json"));
    store.save([{ ...done, settings: { ...done.settings, turnTimeoutSeconds: 30 } }]);
    assert.equal(store.load().matches[0]?.result?.winnerId, "black");
  } finally { rmSync(folder, { recursive: true, force: true }); }
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
    const reloaded = store.load().matches;
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

test("the accepted-move durable boundary reloads one canonical move and resumes black", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-move-boundary-"));
  try {
    const path = join(folder, "matches.json");
    const store = new MatchStore(path);
    const records: MatchRecord[] = [];
    let boundary: Buffer | undefined;
    const { controller } = harness(async (model) => model === "white-model" ? action("e2e4") : resign, records, (items) => {
      store.save(items);
      if (!boundary && items[0]?.history.length === 1 && items[0].history[0]?.valid) boundary = readFileSync(path);
    });
    const match = await create(controller);
    await controller.start(match.id);
    await waitFor(controller, match.id, ["finished"]);
    assert.ok(boundary);
    const crashPath = join(folder, "crash.json");
    writeFileSync(crashPath, boundary);
    const loaded = new MatchStore(crashPath).load();
    assert.equal(loaded.quarantined, 0);
    const saved = loaded.matches[0]!;
    const game = new ChessGame();
    const restored = game.deserialize(saved.gameState);
    assert.equal(saved.history.length, 1);
    assert.equal(saved.history[0]?.actionLabel, "e2e4");
    assert.equal((saved.gameState as { moves: unknown[] }).moves.length, 1);
    assert.equal((saved.gameState as { fen: string }).fen, restored.chess.fen());
    assert.equal((saved.gameState as { pgn: string }).pgn, restored.chess.pgn());
    assert.equal(game.currentPlayer(restored), "black");
    const resumed = harness(async () => resign, loaded.matches);
    await resumed.controller.start(saved.id);
    const done = await waitFor(resumed.controller, saved.id, ["finished"]);
    assert.equal(done.history.length, 2);
    assert.equal((done.gameState as { moves: unknown[] }).moves.length, 1);
    assert.equal(done.history[1]?.playerId, "black");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("retry exhaustion commits invalid evidence and forfeit together", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-forfeit-boundary-"));
  try {
    const path = join(folder, "matches.json");
    const store = new MatchStore(path);
    const records: MatchRecord[] = [];
    const committed: MatchRecord[] = [];
    const { controller } = harness(async () => action("a1a8"), records, (items) => {
      store.save(items);
      committed.push(structuredClone(items[0]!));
    });
    const match = await create(controller);
    await controller.start(match.id);
    await waitFor(controller, match.id, ["forfeit"]);
    assert.ok(committed.every((item) => item.history.length === 0 || item.status === "forfeit"));
    const loaded = store.load();
    assert.equal(loaded.quarantined, 0);
    const saved = loaded.matches[0]!;
    assert.equal(saved.status, "forfeit");
    assert.equal(saved.history[0]?.attempts.length, 2);
    assert.equal(saved.pendingTurn, undefined);
    assert.equal(saved.result?.winnerId, "black");
    assert.equal(harness(async () => resign, loaded.matches).controller.get(saved.id)?.status, "forfeit");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("presentation events publish without their own durable full-store commits", async () => {
  const records: MatchRecord[] = [];
  const committedEventTypes: string[][] = [];
  const { controller } = harness(async () => resign, records, (items) => {
    committedEventTypes.push(items[0]?.events.map((event) => event.type) ?? []);
  });
  const match = await create(controller);
  await controller.start(match.id);
  await waitFor(controller, match.id, ["finished"]);
  assert.ok(committedEventTypes.some((types) => types.includes("match.created")));
  assert.ok(committedEventTypes.some((types) => types.includes("match.started")));
  assert.ok(committedEventTypes.every((types) => !types.some((type) => [
    "agent.ready", "agent.thinking", "agent.started", "agent.response", "move.proposed", "turn.started",
  ].includes(type))));
});

interface ToyState { n: number }

class ToyGame implements GameDefinition<ToyState> {
  readonly id = "toy";
  readonly version = "toy-1";
  readonly observationVersion = "toy-observation-1";
  readonly actionSchemaVersion = "toy-action-1";
  readonly playerIds = ["a", "b"] as const;
  playerLabel(playerId: string): string {
    if (playerId !== "a" && playerId !== "b") throw new Error(`Unknown toy player ${playerId}.`);
    return playerId.toUpperCase();
  }
  createState(): ToyState { return { n: 0 }; }
  currentPlayer(state: ToyState): string | null { return this.isTerminal(state) ? null : state.n % 2 === 0 ? "a" : "b"; }
  plyCount(state: ToyState): number { return state.n; }
  observe(state: ToyState, context: ObservationContext) {
    return {
      schemaVersion: this.observationVersion,
      gameId: this.id,
      matchId: context.matchId,
      turnId: context.turnId,
      playerId: context.player.id,
      playerLabel: context.player.label,
      sideToMove: context.player.id,
      ply: context.ply,
      turnIndex: context.turnIndex,
      state: { n: state.n },
      legalActions: [{ type: "inc", payload: {} }],
      actionSchema: { type: "object" },
      history: [],
      clock: { turnTimeoutMs: context.turnTimeoutMs },
      status: "active" as const,
      ...(context.feedback ? { feedback: context.feedback } : {}),
    };
  }
  validateAction(state: ToyState, playerId: string, action: unknown) {
    if (this.currentPlayer(state) !== playerId) return { valid: false, reason: "Not this player's turn." };
    const envelope = parseActionEnvelope(action);
    if (!envelope || envelope.type !== "inc" || Object.keys(envelope.payload).length !== 0) return { valid: false, reason: "Only an empty inc action is allowed." };
    return { valid: true };
  }
  applyAction(state: ToyState, playerId: string, action: unknown): ToyState {
    const validation = this.validateAction(state, playerId, action);
    if (!validation.valid) throw new Error(validation.reason ?? "Invalid toy action.");
    return { n: state.n + 1 };
  }
  isTerminal(state: ToyState): boolean { return state.n >= 2; }
  result(state: ToyState) { return state.n >= 2 ? { kind: "win" as const, winnerId: "a", notation: "1-0", reason: "Toy terminal" } : undefined; }
  winResult(winnerId: string, reason: string) { return { kind: "win" as const, winnerId, notation: "1-0", reason }; }
  publicState(state: ToyState): unknown { return { n: state.n }; }
  serialize(state: ToyState): unknown { return { n: state.n }; }
  deserialize(saved: unknown): ToyState {
    if (!saved || typeof saved !== "object" || typeof (saved as { n?: unknown }).n !== "number") throw new Error("Saved toy state is invalid.");
    return { n: (saved as { n: number }).n };
  }
  actionLabel(): string { return "inc"; }
  eventProjection(): Record<string, unknown> { return {}; }
}

test("stop during an active request cancels without applying a move", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { controller } = harness(async () => { await gate; return action("e2e4"); });
  const match = await create(controller);
  await controller.start(match.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await controller.stop(match.id);
  const stopped = controller.get(match.id)!;
  assert.equal(stopped.status, "stopped");
  assert.equal((stopped.gameState as { moves: unknown[] }).moves.length, 0);
  assert.equal(stopped.result, undefined);
  release();
});

test("stop on a ready match never creates an adapter and is idempotent", async () => {
  let created = 0;
  const registry = new AgentRegistry();
  registry.register("codex", (config) => { created += 1; return new ScriptedAgent(config, async () => resign); });
  const controller = new MatchController(new GameRegistry().register(new ChessGame()), registry, [], async () => providers, () => undefined);
  const match = await controller.create({ gameId: "chess", players: { white: config("w"), black: config("b") }, turnTimeoutSeconds: 30 });
  await controller.stop(match.id);
  assert.equal(controller.get(match.id)?.status, "stopped");
  assert.equal(created, 0);
  await controller.stop(match.id);
  assert.equal(controller.get(match.id)?.status, "stopped");
});

test("start is idempotent while a match is running", async () => {
  const { controller } = harness(async () => new Promise<GameAction>(() => undefined));
  const match = await create(controller);
  await controller.start(match.id);
  const again = await controller.start(match.id);
  assert.equal(again.id, match.id);
  assert.equal(controller.list().filter((item) => item.status === "running").length, 1);
  await controller.stop(match.id);
  assert.equal(controller.get(match.id)?.status, "stopped");
});

test("resume continues a durable in-flight turn with its prior retry budget", async () => {
  const observations: GameObservation[] = [];
  const { controller } = harness(async (model, observation) => {
    observations.push(observation);
    if (model === "black-model") return resign;
    return observation.feedback ? action("e2e4") : action("a1a8");
  });
  const match = await create(controller);
  match.status = "paused";
  match.pendingTurn = {
    turnId: "seed-turn",
    turnIndex: 1,
    ply: 1,
    playerId: "white",
    startedAt: new Date().toISOString(),
    feedback: 'Move "a1a8" is illegal in the current position.',
    attempts: [{ attempt: 1, startedAt: new Date().toISOString(), status: "invalid", toolCalls: null, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" }, error: "illegal" }],
  };
  await controller.start(match.id);
  const done = await waitFor(controller, match.id, ["finished"]);
  assert.equal(done.history[0].retryCount, 1);
  assert.equal(done.history[0].attempts.length, 2);
  assert.equal(done.history[0].turnId, "seed-turn");
  assert.ok(observations[0].feedback);
});

test("controller advances a game that returns fresh immutable state", async () => {
  const registry = new AgentRegistry();
  registry.register("codex", (config) => new ScriptedAgent(config, async () => ({ type: "inc", payload: {} })));
  const controller = new MatchController(
    new GameRegistry().register(new ToyGame()), registry, [], async () => providers, () => undefined,
  );
  const match = await controller.create({ gameId: "toy", players: { a: config("a"), b: config("b") }, turnTimeoutSeconds: 30 });
  await controller.start(match.id);
  const done = await waitFor(controller, match.id, ["finished"]);
  assert.equal(done.status, "finished");
  assert.deepEqual(done.gameState, { n: 2 });
  assert.equal(done.history.length, 2);
  assert.deepEqual(done.history.map((turn) => turn.ply), [1, 2]);
  assert.deepEqual(done.history.map((turn) => turn.turnIndex), [1, 2]);
});

function legacyRecord(id: string): MatchRecord {
  const game = new ChessGame();
  return {
    id,
    gameId: "chess",
    gameVersion: game.version,
    protocolVersion: "game-action-v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "interrupted",
    revision: 0,
    players: [
      { id: "white", label: "White", agent: { provider: "codex", model: "", name: "Codex · CLI default" } },
      { id: "black", label: "Black", agent: { provider: "codex", model: "", name: "Codex · CLI default" } },
    ],
    settings: { turnTimeoutSeconds: 30, maxRetries: 1, retryPolicy: "retry-invalid-once-then-forfeit", promptVersion: "x", toolSchemaVersion: "game-action-v1", resultPolicy: "engine-terminal-with-arena-adjudication", budgets: { maxPlies: 150, maxRequests: 200, maxWallMinutes: 30, maxReportedCostUsd: null } },
    gameState: game.serialize(game.createState()),
    history: [],
    events: [],
  };
}

test("multiple legacy active records block creation until each is stopped", async () => {
  const records = [legacyRecord("legacy-1"), legacyRecord("legacy-2")];
  const registry = new AgentRegistry();
  registry.register("codex", (config) => new ScriptedAgent(config, async () => resign));
  const controller = new MatchController(new GameRegistry().register(new ChessGame()), registry, records, async () => providers, () => undefined);
  await assert.rejects(
    controller.create({ gameId: "chess", players: { white: config("w"), black: config("b") }, turnTimeoutSeconds: 30 }),
    /Another match|current match|Stop/i,
  );
  await controller.stop("legacy-1");
  await assert.rejects(
    controller.create({ gameId: "chess", players: { white: config("w"), black: config("b") }, turnTimeoutSeconds: 30 }),
    /Another match|current match|Stop/i,
  );
  await controller.stop("legacy-2");
  const created = await controller.create({ gameId: "chess", players: { white: config("w"), black: config("b") }, turnTimeoutSeconds: 30 });
  assert.equal(created.status, "ready");
  assert.equal(controller.list().filter((match) => match.status === "stopped").length, 2);
});

test("a match is not added when its first save fails", async () => {
  const registry = new AgentRegistry();
  registry.register("codex", (config) => new ScriptedAgent(config, async () => resign));
  const controller = new MatchController(new GameRegistry().register(new ChessGame()), registry, [], async () => providers, () => { throw new Error("disk full"); });
  await assert.rejects(
    controller.create({ gameId: "chess", players: { white: config("w"), black: config("b") }, turnTimeoutSeconds: 30 }),
    /could not be saved|disk full/i,
  );
  assert.equal(controller.list().length, 0);
});

test("a failed start checkpoint ends the match without creating an adapter", async () => {
  let created = 0;
  let fail = false;
  const registry = new AgentRegistry();
  registry.register("codex", (config) => { created += 1; return new ScriptedAgent(config, async () => action("e2e4")); });
  const controller = new MatchController(new GameRegistry().register(new ChessGame()), registry, [], async () => providers, () => { if (fail) throw new Error("disk full"); });
  const match = await controller.create({ gameId: "chess", players: { white: config("w"), black: config("b") }, turnTimeoutSeconds: 30 });
  fail = true;
  await assert.rejects(controller.start(match.id), /Could not save|disk full/i);
  const done = controller.get(match.id)!;
  assert.equal(done.status, "error");
  assert.match(done.error ?? "", /Could not save|disk full/i);
  assert.equal(created, 0);
});

test("a failed final checkpoint never reports a saved result", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-final-failure-"));
  try {
    const store = new MatchStore(join(folder, "matches.json"));
    const records: MatchRecord[] = [];
    let failFinal = true;
    const { controller } = harness(async () => resign, records, (items) => {
      if (failFinal && items[0]?.status === "finished") throw new Error("disk full");
      store.save(items);
    });
    const match = await create(controller);
    await controller.start(match.id);
    const failed = await waitFor(controller, match.id, ["error", "finished"]);
    assert.equal(failed.status, "error");
    assert.equal(failed.result, undefined);
    assert.match(failed.error ?? "", /storage|save|disk full/i);
    assert.equal(store.load().matches[0].result, undefined);
    failFinal = false;
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("a failed stop checkpoint rejects the stop acknowledgement", async () => {
  let failStop = false;
  const { controller } = harness(async () => resign, [], (items) => {
    if (failStop && items[0]?.status === "stopped") throw new Error("disk full");
  });
  const match = await create(controller);
  failStop = true;
  await assert.rejects(controller.stop(match.id), /disk full|storage|save/i);
  assert.equal(controller.get(match.id)?.status, "error");
});

test("a failed accepted-move checkpoint halts before the next request", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-move-failure-"));
  try {
    const store = new MatchStore(join(folder, "matches.json"));
    const records: MatchRecord[] = [];
    let calls = 0;
    const { controller } = harness(async () => { calls += 1; return action("e2e4"); }, records, (items) => {
      if (items[0]?.events.some((event) => event.type === "move.applied")) throw new Error("rename failed");
      store.save(items);
    });
    const match = await create(controller);
    await controller.start(match.id);
    const failed = await waitFor(controller, match.id, ["error"]);
    assert.equal(calls, 1);
    assert.equal((failed.gameState as { moves: unknown[] }).moves.length, 0);
    assert.equal(store.load().matches[0].status, "running");
    await assert.rejects(controller.start(match.id), /Could not save/i);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("a failed retry checkpoint keeps the first attempt and prevents a second call", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-retry-failure-"));
  try {
    const store = new MatchStore(join(folder, "matches.json"));
    const records: MatchRecord[] = [];
    let calls = 0;
    const { controller } = harness(async () => { calls += 1; return action("a1a8"); }, records, (items) => {
      if (items[0]?.events.at(-1)?.type === "turn.retry") throw new Error("rename failed");
      store.save(items);
    });
    const match = await create(controller);
    await controller.start(match.id);
    await waitFor(controller, match.id, ["error"]);
    assert.equal(calls, 1);
    assert.equal(store.load().matches[0].pendingTurn?.attempts.length, 1);
    assert.equal(store.load().matches[0].pendingTurn?.attempts[0].status, "started");
    assert.equal(controller.getRecoveryCandidate()?.pendingTurn?.attempts[0].status, "invalid");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("failed pause and shutdown checkpoints report failure after cancelling a request", async () => {
  for (const command of ["pause", "shutdown"] as const) {
    const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-control-failure-"));
    try {
      const store = new MatchStore(join(folder, "matches.json"));
      const records: MatchRecord[] = [];
      const { controller } = harness(async () => new Promise<GameAction>(() => undefined), records, (items) => {
        if (items[0]?.status === "paused") throw new Error("disk full");
        store.save(items);
      });
      const match = await create(controller);
      await controller.start(match.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assert.rejects(command === "pause" ? controller.pause(match.id) : controller.shutdown(), /disk full|save/i);
      assert.equal(controller.get(match.id)?.status, "error");
      assert.equal(store.load().matches[0].status, "running");
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }
});

test("restore rejects a stored result that does not match the replayed game", () => {
  const record = legacyRecord("tampered-result");
  record.status = "finished";
  record.result = { kind: "win", winnerId: "white", notation: "1-0", reason: "fabricated" };
  const registry = new AgentRegistry();
  registry.register("codex", (config) => new ScriptedAgent(config, async () => resign));
  const controller = new MatchController(new GameRegistry().register(new ChessGame()), registry, [record], async () => providers, () => undefined);
  assert.equal(controller.get("tampered-result")?.status, "error");
  assert.match(controller.get("tampered-result")?.error ?? "", /does not match/i);
});

test("a match stops at the ply budget without a fabricated result", async () => {
  const { controller } = harness(async (model) => model === "white-model" ? action("e2e4") : action("e7e5"));
  const match = await controller.create({
    gameId: "chess",
    players: { white: config("white-model"), black: config("black-model") },
    turnTimeoutSeconds: 30,
    budgets: { maxPlies: 1, maxRequests: 50, maxWallMinutes: 30, maxReportedCostUsd: null },
  });
  await controller.start(match.id);
  const done = await waitFor(controller, match.id, ["stopped"]);
  assert.match(done.error ?? "", /Budget reached/);
  assert.equal(done.result, undefined);
  assert.equal((done.gameState as { moves: unknown[] }).moves.length, 1);
  assert.equal(done.settings.budgets.maxPlies, 1);
});

test("new matches capture requested budgets and environment provenance", async () => {
  const { controller } = harness(async () => resign);
  const match = await controller.create({
    gameId: "chess",
    players: { white: config("w"), black: config("b") },
    turnTimeoutSeconds: 30,
    budgets: { maxPlies: 42, maxRequests: 7, maxWallMinutes: 5, maxReportedCostUsd: 1.5 },
  });
  assert.deepEqual(match.settings.budgets, { maxPlies: 42, maxRequests: 7, maxWallMinutes: 5, maxReportedCostUsd: 1.5 });
  assert.equal(match.environment?.adapterVersion, "agent-battle/adapter-v2");
  assert.equal(match.environment?.cliVersions.codex, "test");
});
