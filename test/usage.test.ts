import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, matchReportedCost, matchRequests } from "../src/domain/usage.js";
import { competitorId } from "../src/shared.js";
import type { AgentAttempt, MatchRecord } from "../src/shared.js";

function attempt(usage: AgentAttempt["usage"], status: AgentAttempt["status"] = "valid"): AgentAttempt {
  return { attempt: 1, startedAt: "2026-01-01T00:00:00.000Z", status, toolCalls: null, usage };
}

test("unknown usage is reported as none/partial, never as a confident zero", () => {
  const none = aggregateUsage([attempt({ inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" })]);
  assert.equal(none.coverage, "none");
  assert.equal(none.inputTokens, 0);

  const partial = aggregateUsage([
    attempt({ inputTokens: 10, outputTokens: 2, costUsd: null, coverage: "partial" }),
    attempt({ inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" }, "cancelled"),
  ]);
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.inputTokens, 10);
  assert.equal(partial.requests, 2);
});

test("aggregate totals sum every reported category", () => {
  const total = aggregateUsage([
    attempt({ inputTokens: 100, outputTokens: 10, costUsd: 0.5, cachedInputTokens: 7, cacheWriteTokens: 3, reasoningTokens: 2, coverage: "full" }),
    attempt({ inputTokens: 20, outputTokens: 4, costUsd: 0.25, cachedInputTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0, coverage: "full" }),
  ]);
  assert.deepEqual({ input: total.inputTokens, output: total.outputTokens, cost: total.costUsd, cached: total.cachedInputTokens, cacheWrite: total.cacheWriteTokens, reasoning: total.reasoningTokens, coverage: total.coverage }, { input: 120, output: 14, cost: 0.75, cached: 8, cacheWrite: 3, reasoning: 2, coverage: "full" });
});

test("failed, retried and cancelled attempts count toward request and cost totals", () => {
  const record = {
    history: [
      { attempts: [attempt({ inputTokens: 1, outputTokens: 1, costUsd: 0.1, coverage: "partial" }, "invalid"), attempt({ inputTokens: 1, outputTokens: 1, costUsd: 0.2, coverage: "partial" })] },
      { attempts: [attempt({ inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" }, "cancelled")] },
    ],
    pendingTurn: { attempts: [attempt({ inputTokens: 1, outputTokens: 1, costUsd: 0.3, coverage: "partial" }, "timeout")] },
  } as unknown as MatchRecord;
  assert.equal(matchRequests(record), 4);
  assert.ok(Math.abs((matchReportedCost(record) ?? 0) - 0.6) < 1e-9);
});

test("competitor identity includes reasoning and a resolved model, and is stable", () => {
  assert.equal(competitorId({ provider: "codex", model: "", name: "x" }), "codex::cli-default::default");
  assert.equal(competitorId({ provider: "codex", model: "", name: "x", reasoning: "low" }), "codex::cli-default::low");
  assert.equal(competitorId({ provider: "claude", model: "opus", name: "x", reasoning: "High" }), "claude::opus::high");
  assert.equal(competitorId({ provider: "codex", model: "", name: "x", resolvedModel: "gpt-5-2026" }), "codex::gpt-5-2026::default");
});
