import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeResearchSeries, hangmanPilotPlan, hangmanPilotSeed, validateResearchPlan, researchMatchBudgets } from "../src/server/researchPlan.js";
import { analyzeResearchSeries, pairedBootstrap } from "../src/server/researchAnalysis.js";
import { publicSeries, seriesExport, SeriesManager } from "../src/server/series.js";
import { validateSeriesRecord } from "../src/server/schema.js";
import { selectWord } from "../src/games/hangman/corpus.js";
import { inspectExecutionStream } from "../src/server/executionEvidence.js";
import { researchExecutionReasons } from "../src/domain/executionEvidence.js";
import { comparisonEligibility } from "../src/domain/comparison.js";
import { AgentRegistry } from "../src/domain/agent.js";
import { MatchController } from "../src/domain/MatchController.js";
import { defaultGames } from "../src/domain/defaultGames.js";
import { MatchStore } from "../src/server/store.js";
import type { MatchRecord, PlayerConfig, SeriesRecord } from "../src/shared.js";

const agents: [PlayerConfig, PlayerConfig] = [{ provider: "claude", model: "fixture-a", name: "A", reasoning: "medium" }, { provider: "claude", model: "fixture-b", name: "B", reasoning: "medium" }];
const budgets = { maxPlies: 64, maxRequests: 128, maxWallMinutes: 60, maxReportedCostUsd: null };
const smallPlan = { ...hangmanPilotPlan, blocks: 2, replicates: 1 };
const stream = (model: string) => [ { type: "system", subtype: "init", tools: [] }, { type: "assistant", message: { model } }, { type: "result", modelUsage: { [model]: {} } } ].map((v) => JSON.stringify(v)).join("\n");
const evidence = (model: string) => inspectExecutionStream({ ...agents[0], model }, stream(model), "fixture only");

test("registered pilot pairs 24 distinct words, balances roles, and reproduces its frozen schedule", () => {
  const seed = hangmanPilotSeed();
  const series = makeResearchSeries(agents, 120, budgets, hangmanPilotPlan, seed);
  const again = makeResearchSeries(agents, 120, budgets, hangmanPilotPlan, seed);
  assert.equal(series.slots.length, 144);
  assert.equal(series.planHash, again.planHash);
  assert.deepEqual(series.slots.map((slot) => ({ ...slot, id: "ignored" })), again.slots.map((slot) => ({ ...slot, id: "ignored" })));
  const words = new Set<string>();
  for (let block = 0; block < 24; block++) {
    const slots = series.slots.filter((slot) => slot.blockId === `block-${block}`);
    assert.equal(slots.length, 6);
    assert.equal(new Set(slots.map((slot) => slot.challengeSeed)).size, 1);
    assert.equal(slots.filter((slot) => slot.roles.player1 === 0).length, 3);
    words.add(selectWord(slots[0].challengeSeed!).word);
  }
  assert.equal(words.size, 24);
  assert.equal(validateSeriesRecord(series).planHash, series.planHash);
  assert.equal(JSON.stringify(publicSeries(series, [])).includes(seed), false);
  assert.equal(JSON.stringify(seriesExport(series, [])).includes(seed), false);
  for (const mutation of [ (s: SeriesRecord) => { s.planHash = "0".repeat(64); }, (s: SeriesRecord) => { s.slots[0].replicate = 99; }, (s: SeriesRecord) => { s.settings.budgets.maxRequests++; }, (s: SeriesRecord) => { s.slots[0].challengeSeed = "ff".repeat(32); } ]) {
    const altered = structuredClone(series); mutation(altered); assert.throws(() => validateSeriesRecord(altered));
  }
  series.status = "completed";
  assert.equal(seriesExport(series, []).reproducibility?.masterSeed, seed);
});

test("research declarations reject unbalanced roles, extra keys, and mislabeled same-model comparisons", () => {
  assert.throws(() => validateResearchPlan({ ...smallPlan, extra: true }));
  assert.throws(() => validateResearchPlan({ ...smallPlan, blocks: 1 }));
  const unpaired = structuredClone(smallPlan); unpaired.conditions[1].rolePolicy = "alternating";
  assert.throws(() => validateResearchPlan(unpaired), /paired roles/);
  assert.throws(() => makeResearchSeries([agents[0], agents[0]], 120, budgets, smallPlan));
  const control = { ...smallPlan, comparison: { ...smallPlan.comparison, kind: "same-model-control" } };
  assert.equal(makeResearchSeries([agents[0], agents[0]], 120, budgets, control).researchPlan?.comparison.kind, "same-model-control");
});

function syntheticMatches(series: SeriesRecord): MatchRecord[] {
  return series.slots.map((slot) => {
    const id = randomUUID(); slot.matchIds = [id];
    const players = Object.entries(slot.roles).map(([id, index]) => ({ id, label: id, agent: series.agents[index] }));
    return { id, status: "finished", settings: { turnTimeoutSeconds: series.settings.turnTimeoutSeconds, budgets: researchMatchBudgets(series.settings.budgets) }, gameId: slot.gameId, gameVersion: slot.gameVersion,
      series: { id: series.id, slotId: slot.id, conditionId: slot.conditionId, blockId: slot.blockId, planHash: series.planHash, attempt: 1 }, players,
      result: { kind: "win", winnerId: Object.entries(slot.roles).find(([, index]) => index === (slot.conditionId === "shared" ? 0 : 1))![0] },
      environment: { noToolsPlayerIds: players.map((p) => p.id) },
      history: players.map((p) => ({ playerId: p.id, valid: true, attempts: [{ status: "valid", usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" }, resolvedModel: p.agent.model, toolCalls: 0, sessionId: randomUUID(), execution: evidence(p.agent.model) }] })) } as unknown as MatchRecord;
  });
}

test("primary analysis clusters blocks and retains failed first attempts despite successful reruns", () => {
  const series = makeResearchSeries(agents, 120, budgets, smallPlan);
  const matches = syntheticMatches(series);
  assert.equal(analyzeResearchSeries(series, matches).primary.estimate, null, "no live primary estimate");
  series.status = "completed";
  let analysis = analyzeResearchSeries(series, matches);
  assert.equal(analysis.primary.estimate, 1);
  assert.deepEqual(analysis.primary.confidenceInterval95, [1, 1]);
  assert.deepEqual(analysis.primary.missingOutcomeBounds, [1, 1]);
  const first = matches[0], rerun = structuredClone(first); rerun.id = randomUUID();
  for (const turn of rerun.history) for (const attempt of turn.attempts) attempt.sessionId = randomUUID();
  series.slots[0].matchIds.push(rerun.id); matches.push(rerun);
  first.history[0].attempts[0].execution!.unknownEvents = true;
  analysis = analyzeResearchSeries(series, matches);
  assert.equal(analysis.primary.completeBlocks, 1);
  assert.equal(analysis.rows[0].score, null);
  assert.equal(analysis.primary.confidenceInterval95, null);
  assert.ok(analysis.primary.missingOutcomeBounds![0] < 1);
  assert.equal(publicSeries(series, matches).aggregate["overall:0"].normalizedPerformance, null);
  delete first.history[0].attempts[0].execution;
  assert.equal(comparisonEligibility(first).eligible, false);
  const wrong = structuredClone(matches[1]); wrong.series!.planHash = "wrong";
  assert.equal(analyzeResearchSeries(series, [wrong]).rows[1].score, null);
});

test("analysis rejects changed resource assignments and session reuse across matches", () => {
  const series = makeResearchSeries(agents, 120, budgets, smallPlan);
  const matches = syntheticMatches(series);
  matches[0].history[0].attempts[0].sessionId = matches[1].history[0].attempts[0].sessionId;
  matches[2].settings.budgets.maxRequests++;
  const analysis = analyzeResearchSeries(series, matches);
  assert.equal(analysis.rows[0].eligible, false);
  assert.equal(analysis.rows[1].eligible, false);
  assert.equal(analysis.rows[2].eligible, false);
});

test("research retries cannot replace qualification failures or exceed the registered limit", () => {
  const series = makeResearchSeries(agents, 120, budgets, smallPlan);
  const matches = syntheticMatches(series);
  const first = matches[0]; first.status = "error"; delete first.result;
  first.history[0].attempts[0].status = "error";
  first.history[0].attempts[0].phase = "qualification";
  series.status = "paused";
  const controller = { list: () => matches, active: () => undefined } as unknown as MatchController;
  const manager = new SeriesManager([series], controller, () => undefined);
  assert.throws(() => manager.retry(series.id), /qualification failures/);
  first.history[0].attempts[0].phase = "provider";
  series.slots[0].matchIds.push(first.id);
  assert.throws(() => manager.retry(series.id), /retry limit/);
  const empty = new SeriesManager([], { active: () => undefined } as unknown as MatchController, () => undefined);
  assert.throws(() => empty.create(agents, 120, budgets, undefined, undefined, null), /Invalid research plan/);
});

test("block bootstrap is deterministic and reports insufficient independent blocks", () => {
  assert.equal(pairedBootstrap([0.2], "seed"), null);
  assert.deepEqual(pairedBootstrap([-1, 0, 1], "seed", 100), pairedBootstrap([-1, 0, 1], "seed", 100));
  assert.throws(() => pairedBootstrap([0, NaN], "seed"));
});

test("research evidence fails closed for incomplete streams, unknown events, conflicting identity, and tool inventory", () => {
  const config = agents[0];
  assert.deepEqual(researchExecutionReasons(evidence(config.model), config.model), []);
  for (const output of [stream(config.model).split("\n").slice(0, -1).join("\n"), `${stream(config.model)}\nnot json`, `${stream(config.model)}\n{"type":"new_event"}`, stream(config.model).replace('"tools":[]', '"tools":["Bash"]'), stream(config.model).replace('"tools":[]', '"other":[]'), stream(config.model).replace('"modelUsage":{"fixture-a":{}}', '"modelUsage":{"fixture-a":{},"other-model":{}}')]) {
    assert.ok(researchExecutionReasons(inspectExecutionStream(config, output, "test"), config.model).length > 0);
  }
  assert.ok(researchExecutionReasons(undefined, config.model).length);
  const series = makeResearchSeries([config, config], 120, budgets, { ...smallPlan, comparison: { ...smallPlan.comparison, kind: "same-model-control" } });
  const [match] = syntheticMatches(series);
  assert.equal(comparisonEligibility(match).eligible, true);
  match.history[1].attempts[0].sessionId = match.history[0].attempts[0].sessionId;
  assert.equal(comparisonEligibility(match).eligible, false);
});

test("research fixture executes both rulesets, persists evidence, and honors registered match budgets", async () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-battle-research-"));
  const store = new MatchStore(join(folder, "matches.json"));
  const matches: MatchRecord[] = [], records: SeriesRecord[] = [];
  const registry = new AgentRegistry().register("claude", (config) => ({ id: config.model, config, isolationQualified: true,
    initialize: async () => undefined, shutdown: async () => undefined,
    act: async (observation) => ({ action: observation.legalActions![0], latencyMs: 1, responseExcerpt: "fixture only", stderrExcerpt: "", toolCalls: 0,
      resolvedModel: config.model, sessionId: randomUUID(), execution: evidence(config.model), usage: { inputTokens: 3, outputTokens: 2, costUsd: null, coverage: "partial" } }) }));
  const controller = new MatchController(defaultGames, registry, matches, async () => [{ provider: "claude", installed: true, defaultModel: "fixture" }],
    (match, event) => { if (!event) store.save(matches, records); else manager.onMatchChange(match); });
  const manager = new SeriesManager(records, controller, () => store.save(matches, records));
  try {
    const series = manager.create(agents, 120, budgets, undefined, "cd".repeat(32), smallPlan);
    await manager.start(series.id);
    const deadline = Date.now() + 15000;
    while (series.status !== "completed") {
      if (Date.now() > deadline || series.status === "paused") throw new Error(`Series stalled: ${series.status} ${series.error ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(matches.length, 6);
    assert.ok(matches.every((match) => comparisonEligibility(match).eligible));
    assert.ok(matches.every((match) => match.settings.budgets.maxRequests === 128 && match.settings.budgets.maxRequestsPerPlayer === 64));
    const loaded = store.load();
    assert.equal(loaded.matches.length, 6);
    assert.equal(loaded.series[0].planHash, series.planHash);
    assert.equal(analyzeResearchSeries(loaded.series[0], loaded.matches).primary.completeBlocks, 2);
    assert.ok(loaded.matches.every((match) => defaultGames.validateRecord(match) === undefined));
  } finally { await controller.shutdown(); rmSync(folder, { recursive: true, force: true }); }
});
