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
