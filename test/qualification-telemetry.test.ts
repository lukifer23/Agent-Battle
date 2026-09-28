import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, type AgentReply } from "../src/domain/agent.js";
import { MatchController } from "../src/domain/MatchController.js";
import { defaultGames } from "../src/domain/defaultGames.js";
import type { MatchRecord } from "../src/shared.js";

const playerA = { provider: "codex" as const, model: "fixture-a", name: "A" };
const playerB = { provider: "codex" as const, model: "fixture-b", name: "B" };
for (const [label, resolvedModel, toolCalls] of [["wrong model", "fixture-other", 0], ["unknown model", undefined, 0], ["tool use", "fixture-a", 2]] as const) {
  test(`qualification failure preserves real reply telemetry: ${label}`, async () => {
    const records: MatchRecord[] = [];
    const registry = new AgentRegistry().register("codex", (config) => ({ id: config.model, config, isolationQualified: true, initialize: async () => undefined, shutdown: async () => undefined,
      act: async (): Promise<AgentReply> => ({ action: { type: "resign", payload: {} }, latencyMs: 71, responseExcerpt: "private reply", stderrExcerpt: "", resolvedModel, toolCalls,
        usage: { inputTokens: 123, outputTokens: 9, costUsd: 0.04, coverage: "full" } }) }));
    const controller = new MatchController(defaultGames, registry, records, async () => [{ provider: "codex", installed: true, defaultModel: "fixture" }], () => undefined);
    try {
      const match = await controller.create({ gameId: "chess", players: { white: playerA, black: playerB }, turnTimeoutSeconds: 120,
        budgets: { maxPlies: 10, maxRequests: 10, maxWallMinutes: 30, maxReportedCostUsd: null }, series: { id: "series", slotId: "slot", attempt: 1 } });
      await controller.start(match.id);
      const deadline = Date.now() + 2000;
      while (match.status === "running" || match.status === "ready") { if (Date.now() > deadline) throw new Error("Match did not stop."); await new Promise((resolve) => setTimeout(resolve, 5)); }
      assert.equal(match.status, "error"); assert.equal(match.result, undefined);
      const attempt = match.history[0].attempts[0];
      assert.equal(attempt.phase, "qualification");
      assert.equal(attempt.latencyMs, 71);
      assert.equal(attempt.toolCalls, toolCalls);
      assert.equal(attempt.resolvedModel, resolvedModel);
      assert.equal(attempt.usage.inputTokens, 123);
      assert.equal(attempt.usage.costUsd, 0.04);
    } finally { await controller.shutdown(); }
  });
}

test("strict series cannot turn an unverified malformed response into a scored forfeit", async () => {
  const { AgentProtocolError } = await import("../src/domain/agent.js");
  const { comparisonEligibility } = await import("../src/domain/comparison.js");
  const records: MatchRecord[] = [];
  const registry = new AgentRegistry().register("codex", (config) => ({ id: config.model, config, isolationQualified: true,
    initialize: async () => undefined, shutdown: async () => undefined,
    act: async () => { throw new AgentProtocolError("malformed", "bad", 17, "", null, { inputTokens: 23, outputTokens: 2, costUsd: 0.01, coverage: "full" }); } }));
  const controller = new MatchController(defaultGames, registry, records, async () => [{ provider: "codex", installed: true, defaultModel: "fixture" }], () => undefined);
  try {
    const match = await controller.create({ gameId: "chess", players: { white: playerA, black: playerB }, turnTimeoutSeconds: 120, series: { id: "s", slotId: "slot", attempt: 1 } });
    await controller.start(match.id);
    for (let n = 0; n < 200 && match.status === "running"; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(match.status, "error");
    assert.equal(match.result, undefined);
    assert.equal(match.history[0].attempts[0].usage.inputTokens, 23);
    assert.equal(match.history[0].attempts[0].latencyMs, 17);
    assert.equal(comparisonEligibility(match).eligible, false);
  } finally { await controller.shutdown(); }
});

test("comparison requires per-request identity, isolated policies, both participants, and separate sessions", async () => {
  const { comparisonEligibility } = await import("../src/domain/comparison.js");
  const match = { status: "finished", result: { kind: "win", winnerId: "white" },
    players: [{ id: "white", label: "White", agent: playerA }, { id: "black", label: "Black", agent: playerB }],
    environment: { noToolsPlayerIds: ["white", "black"] },
    history: [{ playerId: "white", attempts: [{ resolvedModel: playerA.model, toolCalls: 0, sessionId: "session-a" }] },
      { playerId: "black", attempts: [{ resolvedModel: playerB.model, toolCalls: 0, sessionId: "session-b" }] }] } as unknown as MatchRecord;
  assert.equal(comparisonEligibility(match).eligible, true);
  const missing = structuredClone(match); missing.history.pop();
  assert.equal(comparisonEligibility(missing).eligible, false);
  const shared = structuredClone(match); shared.history[1].attempts[0].sessionId = "session-a";
  assert.match(comparisonEligibility(shared).reasons.join(" "), /session identity was reused/);
  const old = structuredClone(match); delete old.environment;
  assert.equal(comparisonEligibility(old).eligible, false);
  const unknown = structuredClone(match); unknown.history[0].attempts[0].toolCalls = null;
  assert.equal(comparisonEligibility(unknown).eligible, false);
});
