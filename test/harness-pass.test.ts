import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { AgentExecutionError, AgentRegistry, type AgentReply, type AttemptControl } from "../src/domain/agent.js";
import { executionProfileDrift, researchCapabilityRefusal, buildFrozenProfile } from "../src/domain/executionProfile.js";
import { MatchController } from "../src/domain/MatchController.js";
import { GameRegistry } from "../src/domain/game.js";
import { buildScorecard } from "../src/domain/scorecard.js";
import { comparisonEligibility } from "../src/domain/comparison.js";
import { ChessGame } from "../src/games/chess/ChessGame.js";
import { BattleshipGame } from "../src/games/battleship/BattleshipGame.js";
import { buildPrompt, ClaudeCodeAdapter, CodexCLIAdapter, OpenCodeAdapter } from "../src/server/adapters.js";
import { DurableStore } from "../src/server/persistence/index.js";
import { makeResearchSeries } from "../src/server/researchPlan.js";
import { hangmanPilotPlan } from "../src/server/researchPlan.js";
import { sameEvaluatedSystem } from "../src/shared.js";
import type { FrozenExecutionProfile, GameAction, GameObservation, MatchRecord, PlayerConfig } from "../src/shared.js";

const providers = [{ provider: "codex" as const, installed: true, executable: "/fake/codex", version: "test", defaultModel: "test" }];
const resign: GameAction = { type: "resign", payload: {} };

function config(model: string, reasoning = ""): PlayerConfig {
  return { provider: "codex", model, reasoning, name: model };
}

test("evaluated system identity includes provider and reasoning, not only the model string", () => {
  const model: PlayerConfig = { provider: "claude", model: "same", reasoning: "medium", name: "A" };
  const renamed: PlayerConfig = { ...model, name: "B" };
  assert.equal(sameEvaluatedSystem(model, renamed), true);
  assert.equal(sameEvaluatedSystem(model, { ...model, reasoning: "low" }), false);
  assert.equal(sameEvaluatedSystem(model, { ...model, provider: "codex" }), false);
  const budgets = { maxPlies: 20, maxRequests: 8, maxWallMinutes: 4, maxReportedCostUsd: null };
  const plan = structuredClone(hangmanPilotPlan);
  plan.blocks = 2;
  plan.comparison.kind = "same-model-control";
  assert.equal(makeResearchSeries([model, { ...model }], 120, budgets, plan).researchPlan?.comparison.kind, "same-model-control");
  assert.throws(() => makeResearchSeries([model, { ...model, reasoning: "high" }], 120, budgets, plan), /same-model control/);
  plan.comparison.kind = "system-comparison";
  assert.equal(makeResearchSeries([model, { ...model, provider: "codex" }], 120, budgets, plan).researchPlan?.comparison.kind, "system-comparison");
});

test("research preflight follows declared capabilities", () => {
  assert.equal(researchCapabilityRefusal(new ClaudeCodeAdapter({ provider: "claude", model: "m", name: "m" })), undefined);
  assert.match(researchCapabilityRefusal(new CodexCLIAdapter({ provider: "codex", model: "m", name: "m" })) ?? "", /tool inventory/);
  assert.match(researchCapabilityRefusal(new OpenCodeAdapter({ provider: "opencode", model: "m", name: "m" })) ?? "", /tool inventory/);
});

test("a frozen execution profile drift is a qualification failure, not a strategic loss", async () => {
  const frozen = buildFrozenProfile({
    id: "frozen",
    config: config("white-model"),
    restrictions: "frozen-policy",
    capabilities: new ClaudeCodeAdapter({ provider: "claude", model: "white-model", name: "white-model" }).capabilities,
    observedCliVersion: "cli-1",
    isolationQualified: true,
    async initialize() {},
    async act() { throw new Error("unused"); },
    async shutdown() {},
  });
  assert.ok(executionProfileDrift(frozen, {
    provider: "codex", model: "white-model", adapterVersion: frozen.adapterVersion,
    observationProtocolVersion: frozen.observationProtocolVersion, actionProtocolVersion: frozen.actionProtocolVersion,
    cliVersion: "cli-2", restrictions: "frozen-policy", capabilities: frozen.capabilities,
  }).some((reason) => /CLI version/.test(reason)));
  const registry = new AgentRegistry();
  registry.register("codex", (agent) => ({
    id: agent.model, config: agent, isolationQualified: true, restrictions: "frozen-policy", capabilities: frozen.capabilities, observedCliVersion: "cli-2",
    async initialize() {}, async shutdown() {},
    async act(): Promise<AgentReply> {
      return { action: resign, latencyMs: 4, responseExcerpt: "", stderrExcerpt: "", toolCalls: 0, resolvedModel: agent.model, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } };
    },
  }));
  const controller = new MatchController(new GameRegistry().register(new ChessGame()), registry, [], async () => providers, () => undefined, () => undefined, undefined, () => frozen);
  const match = await controller.create({ gameId: "chess", players: { white: config("white-model"), black: config("black-model") }, turnTimeoutSeconds: 30, series: { id: "study", slotId: "slot", attempt: 1 } });
  await controller.start(match.id);
  const deadline = Date.now() + 2000;
  while (match.status === "ready" || match.status === "running") {
    if (Date.now() > deadline) throw new Error(match.status);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(match.status, "error");
  assert.equal(match.result, undefined);
  assert.equal(match.history[0].attempts[0].phase, "qualification");
  assert.match(match.error ?? "", /CLI version/);
  assert.equal(buildScorecard(match).termination.class, "provider-failure");
  await controller.shutdown();
});

test("reservations are durable before the provider acts, and spawn records a pid without applying the action twice", async () => {
  const records: MatchRecord[] = [];
  let seen: string | undefined;
  const registry = new AgentRegistry();
  registry.register("codex", (agent) => ({
    id: agent.model, config: agent, isolationQualified: true,
    async initialize() {}, async shutdown() {},
    async act(_observation: GameObservation, control: AttemptControl): Promise<AgentReply> {
      seen = records[0]?.pendingTurn?.attempts.at(-1)?.ledgerState;
      if (agent.model === "white-model") {
        control.onSpawn?.(77);
        throw new AgentExecutionError("provider crashed after spawn");
      }
      return { action: resign, latencyMs: 1, responseExcerpt: "", stderrExcerpt: "", toolCalls: 0, resolvedModel: agent.model, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } };
    },
  }));
  const controller = new MatchController(new GameRegistry().register(new ChessGame()), registry, records, async () => providers, (_record, event) => { if (!event) records.splice(0, records.length, ...controller.list()); });
  const match = await controller.create({ gameId: "chess", players: { white: config("white-model"), black: config("black-model") }, turnTimeoutSeconds: 30 });
  await controller.start(match.id);
  const deadline = Date.now() + 2000;
  while (match.status === "ready" || match.status === "running") {
    if (Date.now() > deadline) throw new Error(match.status);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(seen, "reserved");
  const attempt = match.history[0].attempts[0];
  assert.equal(attempt.ledgerState, "spawned");
  assert.equal(attempt.ledgerDetail?.pid, 77);
  assert.equal(attempt.status, "error");
  assert.equal(match.result, undefined);
  assert.equal((match.gameState as { moves: unknown[] }).moves.length, 0);
  await controller.shutdown();
});

test("scorecards separate protocol forfeits from resignation and keep unknown usage unknown", async () => {
  const registry = new AgentRegistry();
  registry.register("codex", (agent) => ({
    id: agent.model, config: agent,
    async initialize() {}, async shutdown() {},
    async act(): Promise<AgentReply> {
      const action = agent.model === "resign" ? resign : { type: "move", payload: { move: "a1a8" } };
      return { action, latencyMs: 3, responseExcerpt: "", stderrExcerpt: "", toolCalls: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } };
    },
  }));
  const games = new GameRegistry().register(new ChessGame());
  const resigned = new MatchController(games, registry, [], async () => providers, () => undefined);
  const first = await resigned.create({ gameId: "chess", players: { white: config("resign"), black: config("other") }, turnTimeoutSeconds: 30 });
  await resigned.start(first.id);
  const forfeited = new MatchController(games, registry, [], async () => providers, () => undefined);
  const second = await forfeited.create({ gameId: "chess", players: { white: config("illegal"), black: config("other") }, turnTimeoutSeconds: 30 });
  await forfeited.start(second.id);
  const done = async (controller: MatchController, id: string) => {
    const deadline = Date.now() + 2000;
    while (!["finished", "forfeit", "error"].includes(controller.get(id)!.status)) {
      if (Date.now() > deadline) throw new Error(controller.get(id)!.status);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return controller.get(id)!;
  };
  const resignation = buildScorecard(await done(resigned, first.id));
  const forfeit = buildScorecard(await done(forfeited, second.id));
  assert.equal(resignation.termination.class, "resignation");
  assert.equal(resignation.outcome.seats.black, "win");
  assert.equal(forfeit.termination.class, "protocol-forfeit");
  assert.equal(forfeit.outcome.seats.black, "win");
  assert.equal(forfeit.outcome.kind, "win");
  assert.equal(forfeit.resources.inputTokens, null);
  assert.equal(forfeit.resources.costUsd, null);
  assert.equal(resignation.metrics.find((metric) => metric.key === "acceptedPlies")?.value, 0);
  assert.deepEqual(buildScorecard(await done(forfeited, second.id)), forfeit);
  await resigned.shutdown();
  await forfeited.shutdown();
});

test("a finished shared board does not describe an uncalled opponent as a missing model response", () => {
  const match = {
    status: "finished",
    gameId: "hangman",
    gameVersion: "shared-board-2",
    result: { kind: "win", winnerId: "player1", notation: "1-0", reason: "Higher score (3–0)" },
    players: [
      { id: "player1", label: "Player 1", agent: config("a") },
      { id: "player2", label: "Player 2", agent: config("b") },
    ],
    environment: { noToolsPlayerIds: ["player1", "player2"] },
    history: [{ playerId: "player1", valid: true, attempts: [{ status: "valid", phase: "provider", resolvedModel: "a", toolCalls: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } }] }],
  } as unknown as MatchRecord;
  const reasons = comparisonEligibility(match).reasons;
  assert.ok(reasons.includes("Opponent was not called; the game ended on the previous legal action."));
  assert.equal(reasons.some((reason) => reason.includes("no model response")), false);
  assert.equal(comparisonEligibility(match).eligible, false);
});

test("observation prompts drop duplicate legal-move copies without dropping the legal action", () => {
  const chess = new ChessGame();
  const opening = chess.observe(chess.createState(), { matchId: "m", turnId: "t", player: { id: "white", label: "White", agent: config("w") }, ply: 1, turnIndex: 1, turnTimeoutMs: 1000 });
  assert.equal("legal_moves_uci" in opening.state, false);
  assert.equal(opening.schemaVersion, "chess-observation-v3");
  const native = buildPrompt(opening, "claude");
  const embedded = buildPrompt(opening, "opencode");
  assert.equal(native.includes("legal_moves_uci"), false);
  assert.equal(native.includes("oneOf"), false);
  assert.equal(native.includes("e2e4"), true);
  assert.match(native, /rnbqkbnr/);
  assert.equal(embedded.includes("oneOf"), true);
  assert.ok(Buffer.byteLength(native) < Buffer.byteLength(embedded));
  const battle = new BattleshipGame();
  const placed = battle.createState();
  const fleet = ["carrier", "battleship", "cruiser", "submarine", "destroyer"].map((ship, row) => ({ ship, start: `a${row + 1}`, orientation: "horizontal" }));
  battle.applyAction(placed, "player1", { type: "place_fleet", payload: { ships: fleet } });
  battle.applyAction(placed, "player2", { type: "place_fleet", payload: { ships: fleet } });
  const view = battle.observe(placed, { matchId: "m", turnId: "t", player: { id: "player1", label: "Player 1", agent: config("w") }, ply: 3, turnIndex: 3, turnTimeoutMs: 1000 });
  assert.equal("availableTargets" in view.state, false);
  assert.equal(view.schemaVersion, "battleship-observation-2");
  const prompt = buildPrompt(view, "codex");
  assert.equal(prompt.includes("availableTargets"), false);
  assert.equal(prompt.includes("a1"), true);
  assert.equal(prompt.includes("oneOf"), false);
});

test("history pagination and the durable event log do not collapse to the presentation window", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "agent-battle-page-"));
  try {
    const store = DurableStore.open(dir);
    const chess = new ChessGame();
    for (let index = 0; index < 80; index += 1) {
      const record: MatchRecord = {
        id: `m-${index}`, gameId: "chess", gameVersion: "standard-1", protocolVersion: "game-action-v1",
        createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`, updatedAt: "2026-01-01T01:00:00.000Z", status: "stopped", revision: index + 1,
        players: [
          { id: "white", label: "White", agent: { provider: "codex", model: "left", name: "L" } },
          { id: "black", label: "Black", agent: { provider: "claude", model: "right", name: "R" } },
        ],
        settings: { turnTimeoutSeconds: 30, maxRetries: 1, retryPolicy: "retry-invalid-once-then-forfeit", promptVersion: "observation-contract-v3", toolSchemaVersion: "game-action-v1", resultPolicy: "engine-terminal-with-arena-adjudication", budgets: { maxPlies: 10, maxRequests: 10, maxWallMinutes: 5, maxReportedCostUsd: null } },
        gameState: chess.serialize(chess.createState()), history: [], events: [],
      };
      if (index === 0) {
        record.history = [{ matchId: record.id, ply: 1, turnIndex: 1, turnId: "t", agentId: "a", model: "left", provider: "codex", playerId: "white", playerLabel: "White", legalActionCount: 1, valid: true, latencyMs: 1, retryCount: 0, timestamp: record.createdAt, attempts: [{ attempt: 1, invocationId: "11111111-1111-4111-8111-111111111111", startedAt: record.createdAt, status: "valid", phase: "provider", sessionId: "session-kept", toolCalls: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } }] }];
        record.events = Array.from({ length: 600 }, (_value, sequence) => ({ at: record.createdAt, type: "turn.started", text: `e${sequence + 1}`, sequence: sequence + 1 }));
      }
      store.saveMatch(record);
    }
    const page = store.repository.queryMatches({ limit: 10, offset: 20, provider: "codex" });
    assert.equal(page.matches.length, 10);
    assert.equal(page.total, 80);
    const trimmed = store.repository.getMatch("m-0")!;
    trimmed.events = trimmed.events.slice(-500);
    store.saveMatch(trimmed);
    const durable = store.repository.allEvents("m-0");
    assert.equal(durable[0]?.sequence, 1);
    assert.equal(durable.at(-1)?.sequence, 600);
    assert.equal(durable.length, 600);
    assert.equal(store.repository.getMatch("m-0")?.events.length, 500);
    assert.equal(store.repository.sessionOwner("session-kept")?.matchId, "m-0");
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an execution profile round-trips beside the series without entering record_json", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "agent-battle-profile-"));
  try {
    const store = DurableStore.open(dir);
    const budgets = { maxPlies: 20, maxRequests: 8, maxWallMinutes: 4, maxReportedCostUsd: null };
    const plan = structuredClone(hangmanPilotPlan);
    plan.blocks = 2;
    const series = makeResearchSeries([{ provider: "claude", model: "a", reasoning: "medium", name: "A" }, { provider: "claude", model: "b", reasoning: "medium", name: "B" }], 120, budgets, plan);
    store.saveSeries(series);
    const profile: FrozenExecutionProfile = buildFrozenProfile(new ClaudeCodeAdapter({ provider: "claude", model: "a", reasoning: "medium", name: "A" }));
    store.repository.saveExecutionProfiles(series.id, [profile, { ...profile, requestedModel: "b" }]);
    const loaded = store.repository.getSeries(series.id)!;
    assert.equal(loaded.executionProfiles?.length, 2);
    assert.equal(loaded.executionProfiles?.[1].requestedModel, "b");
    const raw = store.repository.getSeries(series.id)!;
    store.saveSeries(raw);
    const again = store.repository.getSeries(series.id)!;
    assert.equal(again.executionProfiles?.length, 2);
    assert.equal(JSON.parse(JSON.stringify(series)).executionProfiles, undefined);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
