import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { MatchController } from "../src/domain/MatchController.js";
import { AgentExecutionError, AgentRegistry, type AgentReply } from "../src/domain/agent.js";
import { defaultGames } from "../src/domain/defaultGames.js";
import { projectRecord } from "../src/domain/projection.js";
import { MatchStore } from "../src/server/store.js";
import { makeSeries, publicSeries, seriesExport, SeriesManager } from "../src/server/series.js";
import type { MatchRecord, SeriesRecord } from "../src/shared.js";

const agents = [
  { provider: "codex" as const, model: "fixture-a", reasoning: "high", name: "A" },
  { provider: "codex" as const, model: "fixture-b", reasoning: "medium", name: "B" },
] as const;
const budgets = { maxPlies: 150, maxRequests: 30, maxWallMinutes: 30, maxReportedCostUsd: null };

test("series schedule is seeded, role-balanced, and hides future challenge provenance", () => {
  const first = makeSeries([...agents], 120, budgets, "01".repeat(32));
  const second = makeSeries([...agents], 120, budgets, "01".repeat(32));
  assert.deepEqual(first.slots.map((slot) => slot.challengeId), second.slots.map((slot) => slot.challengeId));
  assert.deepEqual(first.slots.map((slot) => slot.roles), second.slots.map((slot) => slot.roles));
  assert.equal(first.slots.filter((slot) => slot.gameId === "chess").length, 5);
  assert.equal(first.slots.filter((slot) => slot.gameId === "hangman").length, 5);
  assert.equal(first.slots.slice(0, 5).filter((slot) => slot.roles.white === 0).length, 3);
  assert.equal(new Set(first.slots.slice(5).map((slot) => slot.challengeId)).size, 5);
  const early = publicSeries(first, []);
  assert.equal(JSON.stringify(early).includes(first.masterSeed), false);
  for (const slot of first.slots.slice(5)) assert.equal(JSON.stringify(early).includes(slot.challengeSeed!), false);
  first.status = "completed";
  assert.equal(publicSeries(first, [], true).slots[5].challengeSeed, first.slots[5].challengeSeed);
});

test("fixture agents complete ten durable slots with event-time Hangman masking and safe export", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-series-"));
  const store = new MatchStore(join(folder, "matches.json"));
  const matches: MatchRecord[] = [];
  const records: SeriesRecord[] = [];
  const registry = new AgentRegistry().register("codex", (config) => ({ id: config.model, config, isolationQualified: true,
    initialize: async () => undefined, shutdown: async () => undefined,
    act: async (observation): Promise<AgentReply> => {
      const match = matches.find((item) => item.id === observation.matchId)!;
      const word = (match.gameState as { word?: string }).word;
      return { action: observation.gameId === "chess" ? (observation.playerId === "white" ? { type: "move", payload: { move: "e2e4" } } : { type: "resign", payload: {} }) : { type: "solve", payload: { word } },
        latencyMs: 1, responseExcerpt: "private fixture", stderrExcerpt: "", toolCalls: 0, resolvedModel: config.model,
        usage: { inputTokens: 10, outputTokens: 2, costUsd: null, coverage: "partial" } };
    } }));
  const controller = new MatchController(defaultGames, registry, matches, async () => [{ provider: "codex", installed: true, defaultModel: "fixture" }],
    (match, event) => { if (!event) store.save(matches, records); else manager?.onMatchChange(match); });
  const manager = new SeriesManager(records, controller, () => store.save(matches, records));
  try {
    const series = makeSeries([...agents], 120, budgets); records.push(series); store.save(matches, records);
    await manager.start(series.id);
    const deadline = Date.now() + 15_000;
    while (series.status !== "completed") {
      if (Date.now() > deadline) throw new Error(`Series did not complete: ${series.status} ${series.error ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(series.slots.length, 10);
    assert.equal(matches.length, 10);
    assert.ok(matches.every((match) => match.status === "finished"));
    assert.ok(matches.every((match) => defaultGames.validateRecord(match) === undefined));
    const loaded = store.load();
    assert.equal(loaded.series.length, 1); assert.equal(loaded.matches.length, 10);
    const detail = projectRecord(matches.find((match) => match.gameId === "hangman")!);
    const word = (matches.find((match) => match.gameId === "hangman")!.gameState as { word: string }).word;
    for (const event of detail.events) if (event.payload?.publicState && !(event.payload.publicState as { terminal: boolean }).terminal) {
      assert.equal(JSON.stringify(event).includes(word), false);
    }
    const exported = seriesExport(series, matches);
    assert.equal(exported.matches.length, 10);
    assert.equal(exported.series.slots[5].challengeSeed, series.slots[5].challengeSeed);
    assert.equal((JSON.parse(readFileSync(join(folder, "matches.json"), "utf8")) as { version: number }).version, 7);
  } finally { await controller.shutdown(); rmSync(folder, { recursive: true, force: true }); }
});

test("failed slot pauses, reloads, and retries the same challenge without erasing evidence", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-series-retry-"));
  const store = new MatchStore(join(folder, "matches.json"));
  let failFirst = true;
  const factory = (matches: MatchRecord[]) => new AgentRegistry().register("codex", (config) => ({ id: config.model, config, isolationQualified: true,
    initialize: async () => undefined, shutdown: async () => undefined,
    act: async (observation): Promise<AgentReply> => {
      if (failFirst) { failFirst = false; throw new AgentExecutionError("fixture provider outage"); }
      const match = matches.find((item) => item.id === observation.matchId)!;
      return { action: observation.gameId === "chess" ? (observation.playerId === "white" ? { type: "move", payload: { move: "e2e4" } } : { type: "resign", payload: {} }) : { type: "solve", payload: { word: (match.gameState as { word: string }).word } },
        latencyMs: 1, responseExcerpt: "", stderrExcerpt: "", toolCalls: 0, resolvedModel: config.model,
        usage: { inputTokens: null, outputTokens: null, costUsd: null, coverage: "none" } };
    } }));
  let matches: MatchRecord[] = [];
  let records: SeriesRecord[] = [];
  let manager: SeriesManager;
  let controller = new MatchController(defaultGames, factory(matches), matches, async () => [{ provider: "codex", installed: true, defaultModel: "fixture" }],
    (match, event) => { if (!event) store.save(matches, records); else manager?.onMatchChange(match); });
  manager = new SeriesManager(records, controller, () => store.save(matches, records));
  try {
    const series = makeSeries([...agents], 120, budgets); records.push(series); store.save(matches, records);
    await manager.start(series.id);
    const deadline = Date.now() + 15_000;
    while (series.status !== "paused") {
      if (Date.now() > deadline) throw new Error("Series did not pause after provider failure.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(series.slots[0].matchIds.length, 1);
    assert.equal(matches[0].status, "error");
    assert.equal(matches[0].result, undefined);
    await controller.shutdown();
    const restored = store.load();
    matches = restored.matches; records = restored.series;
    controller = new MatchController(defaultGames, factory(matches), matches, async () => [{ provider: "codex", installed: true, defaultModel: "fixture" }],
      (match, event) => { if (!event) store.save(matches, records); else manager?.onMatchChange(match); });
    manager = new SeriesManager(records, controller, () => store.save(matches, records));
    manager.retry(series.id);
    while (manager.get(series.id).status !== "completed") {
      if (Date.now() > deadline) throw new Error(`Retried series did not complete: ${manager.get(series.id).error ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const slot = manager.get(series.id).slots[0];
    assert.equal(slot.matchIds.length, 2);
    assert.equal(matches.find((match) => match.id === slot.matchIds[0])?.status, "error");
    assert.equal(matches.find((match) => match.id === slot.matchIds[1])?.status, "finished");
    assert.equal(new Set(slot.matchIds).size, 2);
  } finally { await controller.shutdown(); rmSync(folder, { recursive: true, force: true }); }
});
