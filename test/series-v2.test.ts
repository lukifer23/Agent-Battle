import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { makeSeries, makeSeriesV2, publicSeries, seriesExport, SeriesManager } from "../src/server/series.js";
import { validateSeriesRecord } from "../src/server/schema.js";
import { MatchController } from "../src/domain/MatchController.js";
import { AgentRegistry, type AgentReply } from "../src/domain/agent.js";
import { defaultGames } from "../src/domain/defaultGames.js";
import { projectRecord } from "../src/domain/projection.js";
import { MatchStore } from "../src/server/store.js";
import { verifiedDistinctModels, type MatchRecord, type SeriesPlan, type SeriesRecord } from "../src/shared.js";

const agents = [{ provider: "codex" as const, model: "fixture-a", name: "A" }, { provider: "codex" as const, model: "fixture-b", name: "B" }] as const;
const budgets = { maxPlies: 150, maxRequests: 100, maxWallMinutes: 30, maxReportedCostUsd: null };
const plan: SeriesPlan = { mode: "exploratory", games: [
  { gameId: "chess", gameVersion: "standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" },
  { gameId: "hangman", gameVersion: "independent-lanes-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "seeded" },
  { gameId: "battleship", gameVersion: "battleship-standard-1", repetitions: 1, rolePolicy: "alternating", challengePolicy: "fixed" },
] };
const ships = [
  { ship: "carrier", start: "a1", orientation: "horizontal" }, { ship: "battleship", start: "a2", orientation: "horizontal" },
  { ship: "cruiser", start: "a3", orientation: "horizontal" }, { ship: "submarine", start: "a4", orientation: "horizontal" },
  { ship: "destroyer", start: "a5", orientation: "horizontal" },
];
const targets = ships.flatMap((ship) => Array.from({ length: ({ carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 } as Record<string, number>)[ship.ship] }, (_, index) => `${String.fromCharCode(ship.start.charCodeAt(0) + index)}${ship.start.slice(1)}`));

test("v2 accepts arbitrary registered game plans, records seat imbalance, and reruns exact challenges", () => {
  assert.equal(verifiedDistinctModels({ ...agents[0], resolvedModel: "fixture-a" }, { ...agents[1], resolvedModel: "fixture-b" }), true);
  assert.equal(verifiedDistinctModels({ ...agents[0] }, { ...agents[1], resolvedModel: "fixture-b" }), false);
  const seed = "ab".repeat(32);
  const first = makeSeriesV2([...agents], 120, budgets, plan, seed);
  const again = makeSeriesV2([...agents], 120, budgets, plan, seed);
  assert.deepEqual(first.slots.map((slot) => [slot.gameId, slot.challengeId, slot.roles]), again.slots.map((slot) => [slot.gameId, slot.challengeId, slot.roles]));
  assert.equal(first.slots.length, 3);
  assert.equal(validateSeriesRecord(first).version, "battle-series-2");
  assert.equal(JSON.stringify(publicSeries(first, [])).includes(seed), false);
  assert.equal(JSON.stringify(seriesExport(first, [])).includes(seed), false);
  const altered = structuredClone(first);
  altered.slots[1].challengeId = "forged";
  assert.throws(() => validateSeriesRecord(altered));
  const strict = structuredClone(plan); strict.mode = "strict";
  assert.throws(() => makeSeriesV2([...agents], 120, budgets, strict, seed), /even repetition/);
  first.status = "completed";
  const manifest = seriesExport(first, []).reproducibility!;
  assert.equal(manifest.masterSeed, seed);
  assert.deepEqual(makeSeriesV2(manifest.agents, manifest.settings.turnTimeoutSeconds, manifest.settings.budgets, manifest.plan!, manifest.masterSeed).slots.map((slot) => slot.challengeId), first.slots.map((slot) => slot.challengeId));
});

test("store version 5 backs up and loads historical battle-series-1 without rewriting its plan", () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-v1-migration-"));
  try {
    const path = join(folder, "matches.json");
    const original = makeSeries([...agents], 120, budgets, "ef".repeat(32));
    writeFileSync(path, JSON.stringify({ version: 5, matches: [], series: [original] }));
    const loaded = new MatchStore(path).load();
    assert.equal(loaded.migrated, true);
    assert.ok(loaded.backupPath && existsSync(loaded.backupPath));
    assert.deepEqual(loaded.series[0], original);
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as { version: number }).version, 6);
    assert.equal(seriesExport(loaded.series[0], []).schemaVersion, "battle-series-export-1");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("v2 fixture series completes Chess, Hangman and Battleship with private fleet replay and durable scores", async () => {
  const folder = mkdtempSync(join(os.tmpdir(), "agent-battle-v2-"));
  const store = new MatchStore(join(folder, "matches.json"));
  const matches: MatchRecord[] = [];
  const records: SeriesRecord[] = [];
  const registry = new AgentRegistry().register("codex", (config) => ({ id: config.model, config, isolationQualified: true, initialize: async () => undefined, shutdown: async () => undefined,
    act: async (observation): Promise<AgentReply> => {
      let action;
      if (observation.gameId === "chess") action = { type: "resign", payload: {} };
      else if (observation.gameId === "hangman") action = { type: "solve", payload: { word: (matches.find((item) => item.id === observation.matchId)!.gameState as { word: string }).word } };
      else {
        const state = observation.state as { phase: string; ownShots: Array<{ coordinate: string }> };
        action = state.phase === "placement" ? { type: "place_fleet", payload: { ships } } : { type: "fire", payload: { coordinate: targets.find((target) => !state.ownShots.some((shot) => shot.coordinate === target)) } };
      }
      return { action, latencyMs: 1, responseExcerpt: "fixture only", stderrExcerpt: "", toolCalls: 0, resolvedModel: config.model, usage: { inputTokens: 3, outputTokens: 2, costUsd: null, coverage: "partial" } };
    } }));
  const controller = new MatchController(defaultGames, registry, matches, async () => [{ provider: "codex", installed: true, defaultModel: "fixture" }],
    (match, event) => { if (!event) store.save(matches, records); else manager.onMatchChange(match); });
  const manager = new SeriesManager(records, controller, () => store.save(matches, records));
  try {
    const series = manager.create([...agents], 120, budgets, plan, "cd".repeat(32));
    await manager.start(series.id);
    const deadline = Date.now() + 15_000;
    while (series.status !== "completed") {
      if (Date.now() > deadline) throw new Error(`Series stalled: ${series.status} ${series.error ?? ""}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(matches.map((match) => match.gameId).sort(), ["battleship", "chess", "hangman"]);
    assert.ok(matches.every((match) => match.status === "finished" && defaultGames.validateRecord(match) === undefined));
    const battle = matches.find((match) => match.gameId === "battleship")!;
    const detail = projectRecord(battle);
    const preterminal = detail.replay!.slice(0, -1);
    for (const frame of preterminal) assert.equal(JSON.stringify(frame).includes("placements"), false);
    assert.equal(JSON.stringify(detail.replay!.at(-1)).includes("placements"), true);
    assert.equal(JSON.stringify(detail.history).includes('"ship":"carrier"'), false);
    assert.equal(JSON.stringify(detail.events.filter((event) => !(event.payload?.publicState as { terminal?: boolean })?.terminal)).includes("placements"), false);
    assert.equal(store.load().series[0].version, "battle-series-2");
    const summary = publicSeries(series, matches);
    assert.ok(summary.aggregate["battleship:0"].scored === 1);
    assert.ok(summary.aggregate["overall:0"].normalizedPerformance !== null);
    const exported = seriesExport(series, matches);
    assert.equal(exported.reproducibility?.masterSeed, series.masterSeed);
  } finally { await controller.shutdown(); rmSync(folder, { recursive: true, force: true }); }
});
